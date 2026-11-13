import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把 Phaser PR #7420 的动态缓冲区补丁和绘图缓冲创建失败清理固化到运行时包。
 *
 * 旧逻辑在批次 flush 时用 `bufferSubData` 局部覆盖同一块动态顶点缓冲；同一帧
 * 前面的 draw call 还在引用它，驱动只能复制或等待整块缓冲。补丁在“从偏移 0
 * 上传新批次”时改用 `bufferData` 重新分配存储，让驱动直接丢弃旧存储。
 *
 * 依赖固定在 phaser@4.2.1；升级 Phaser 后先核对 PR 和下面的锚点再更新脚本。
 * 脚本由 postinstall、predev 和 prebuild 自动执行，重复运行会直接跳过。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phaserDir = path.join(root, 'node_modules', 'phaser');
const target = path.join(phaserDir, 'dist', 'phaser.esm.js');
const EXPECTED_VERSION = '4.2.1';

const fail = message => {
  console.error(`Phaser 运行时补丁失败：${message}`);
  process.exit(1);
};

if (!fs.existsSync(target)) fail(`找不到 ${target}，请先安装依赖`);
const version = JSON.parse(fs.readFileSync(path.join(phaserDir, 'package.json'), 'utf8')).version;
if (version !== EXPECTED_VERSION) {
  fail(`补丁按 ${EXPECTED_VERSION} 编写，当前安装的是 ${version}；升级 Phaser 后请先核对 PR #7420`);
}

let source = fs.readFileSync(target, 'utf8');
if (source.includes('_gpuByteLength')) {
  console.log('Phaser 4.2.1 动态缓冲补丁已在位');
}

const replaceOnce = (label, needle, replacement) => {
  // Phaser 的 dist 混用 LF/CRLF；两种换行都试一次，按原文件的写法替换。
  for (const [from, to] of [
    [needle, replacement],
    [needle.replace(/\n/g, '\r\n'), replacement.replace(/\n/g, '\r\n')],
  ]) {
    const first = source.indexOf(from);
    if (first < 0) continue;
    if (source.indexOf(from, first + from.length) >= 0) fail(`${label}的补丁锚点不唯一`);
    source = source.slice(0, first) + to + source.slice(first + from.length);
    return;
  }
  fail(`找不到${label}的补丁锚点`);
};

if (!source.includes('_gpuByteLength')) {
replaceOnce('缓冲区字段',
  `        this.bufferUsage = bufferUsage;

        this.createViews();`,
  `        this.bufferUsage = bufferUsage;

        // Phaser PR #7420：记录 GPU 实际分配的字节数。
        this._gpuByteLength = 0;

        this.createViews();`);

replaceOnce('创建资源',
  `        this.bind();
        gl.bufferData(bufferType, this.dataBuffer, this.bufferUsage);
        this.bind(true);`,
  `        this.bind();
        gl.bufferData(bufferType, this.dataBuffer, this.bufferUsage);
        this._gpuByteLength = this.dataBuffer.byteLength;
        this.bind(true);`);

replaceOnce('更新分支',
  `        if (bytes === undefined)
        {
            gl.bufferSubData(
                this.bufferType,
                offset,
                this.dataBuffer
            );
        }
        else
        {
            gl.bufferSubData(
                this.bufferType,
                offset,
                this.viewU8.subarray(offset, offset + bytes)
            );
        }`,
  `        // Phaser PR #7420：动态缓冲区从偏移 0 上传时重新分配存储，
        // 避免驱动复制或等待仍被前面 draw call 使用的旧缓冲。
        if (bytes !== undefined && offset === 0 && this.bufferUsage !== gl.STATIC_DRAW)
        {
            gl.bufferData(this.bufferType, this.viewU8.subarray(0, bytes), this.bufferUsage);
            this._gpuByteLength = bytes;
        }
        else if (this._gpuByteLength !== this.dataBuffer.byteLength)
        {
            gl.bufferData(this.bufferType, this.dataBuffer, this.bufferUsage);
            this._gpuByteLength = this.dataBuffer.byteLength;
        }
        else if (bytes === undefined)
        {
            gl.bufferSubData(
                this.bufferType,
                offset,
                this.dataBuffer
            );
        }
        else
        {
            gl.bufferSubData(
                this.bufferType,
                offset,
                this.viewU8.subarray(offset, offset + bytes)
            );
        }`);

replaceOnce('扩容',
  `        this.bind();
        gl.bufferData(this.bufferType, this.dataBuffer, this.bufferUsage);
    },

    /**
     * Creates the views into the dataBuffer.`,
  `        this.bind();
        gl.bufferData(this.bufferType, this.dataBuffer, this.bufferUsage);
        this._gpuByteLength = bytes;
    },

    /**
     * Creates the views into the dataBuffer.`);

}

if (!source.includes('清理尚未登记到 renderer 的失败 framebuffer')) {
  replaceOnce('绘图缓冲创建失败清理',
    `        if (this.attachments[0])
        {
            this.renderTexture = this.attachments[0].texture;
        }

        this.createResource();`,
    `        if (this.attachments[0])
        {
            this.renderTexture = this.attachments[0].texture;
        }

        try
        {
            this.createResource();
        }
        catch (error)
        {
            // 清理尚未登记到 renderer 的失败 framebuffer，包括其颜色纹理。
            this.destroy();
            throw error;
        }`);
}

fs.writeFileSync(target, source);
console.log('Phaser 4.2.1 动态缓冲与绘图缓冲失败清理补丁已就绪');
