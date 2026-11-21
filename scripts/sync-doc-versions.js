#!/usr/bin/env node
'use strict';

// ============================================================================
//  Epiphy 文档与组件头部版本号自动同步工具 (SSOT: 各组件运行时导出 VERSION)
//  用法：
//    node scripts/sync-doc-versions.js          # 同步所有 15 个托管组件头部与 4 份核心文档
//    node scripts/sync-doc-versions.js --check  # 仅校验，发现任意漂移则以非 0 退出
// ============================================================================

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const CHECK_ONLY = process.argv.indexOf('--check') >= 0;

const COMPONENT_SPECS = [
    { name: 'EpiphySpec',            file: 'kubejs/startup_scripts/通用组件/Epiphy的-Spec与通用工具.js',     docTags: ['EpiphySpec'] },
    { name: 'Epiphy3DFXCore',        file: 'kubejs/startup_scripts/通用组件/Epiphy的-空间特效核心.js',       docTags: ['Epiphy3DFXCore'] },
    { name: 'EpiphyCreativeTab',     file: 'kubejs/startup_scripts/通用组件/创造模式栏-epiphy.js',           docTags: ['EpiphyCreativeTab'] },
    { name: 'EpiphyLog',             file: 'kubejs/server_scripts/通用组件/Epiphy的-日志.js',               docTags: ['EpiphyLog'] },
    { name: 'EpiphyServerCore',      file: 'kubejs/server_scripts/通用组件/Epiphy的-服务端核心.js',          docTags: ['EpiphyServerCore / EpiphyServerBase'] },
    { name: 'EpiphyBlockTracker',    file: 'kubejs/server_scripts/通用组件/Epiphy的-方块与区块组件.js',      docTags: ['EpiphyBlockTracker / EpiphyWorldOps'] },
    { name: 'EpiphyPermissionValve', file: 'kubejs/server_scripts/通用组件/Epiphy的-权限阀.js',             docTags: ['EpiphyPermissionValve'] },
    { name: 'EpiphyDebug',           file: 'kubejs/server_scripts/通用组件/Epiphy的-调试组件.js',            docTags: ['EpiphyDebug'] },
    { name: 'EpiphyBugfix',          file: 'kubejs/server_scripts/通用组件/Epiphy的-基础bug修复.js',         docTags: ['EpiphyBugfix'] },
    { name: 'Epiphy2DSurface',       file: 'kubejs/server_scripts/通用组件/Epiphy的-平面渲染组件.js',        docTags: ['Epiphy2DSurface / ScreenDanmaku'] },
    { name: 'Epiphy3DFXServer',      file: 'kubejs/server_scripts/通用组件/Epiphy的-空间特效组件.js',        docTags: ['Epiphy3DFXServer'] },
    { name: 'EpiphyAudio',           file: 'kubejs/server_scripts/通用组件/Epiphy的-音频组件.js',            docTags: ['EpiphyAudio'] },
    { name: 'Epiphy2DRenderer',      file: 'kubejs/client_scripts/通用组件/Epiphy的-平面渲染器.js',          docTags: ['Epiphy2DRenderer / ScreenDanmakuClient'] },
    { name: 'Epiphy3DFX',            file: 'kubejs/client_scripts/通用组件/Epiphy的-空间特效渲染器.js',      docTags: ['Epiphy3DFX'] },
    { name: 'EpiphyAudioClient',     file: 'kubejs/client_scripts/通用组件/Epiphy的-音频播放器.js',          docTags: ['EpiphyAudioClient'] }
];

function loadRuntimeVersions() {
    const sb = {
        console: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, log: () => {} },
        StartupEvents: { registry: () => {}, modifyCreativeTab: () => {} },
        ServerEvents: { loaded: () => {}, unloaded: () => {}, tick: () => {}, commandRegistry: () => {}, command: () => {} },
        BlockEvents: { placed: () => {}, broken: () => {} },
        PlayerEvents: { loggedIn: () => {}, loggedOut: () => {} },
        LevelEvents: { loaded: () => {} },
        ClientEvents: { tick: () => {}, loggedIn: () => {}, loggedOut: () => {}, paintScreen: () => {} },
        NetworkEvents: { dataReceived: () => {} },
        Java: { loadClass: () => null },
        Text: { of: (s) => ({ string: String(s) }) },
        global: {}
    };
    sb.globalThis = sb;
    vm.createContext(sb);

    for (const spec of COMPONENT_SPECS) {
        const absPath = path.join(ROOT_DIR, spec.file);
        const code = fs.readFileSync(absPath, 'utf8');
        vm.runInContext(code, sb, { filename: absPath });
    }

    const versions = {};
    for (const spec of COMPONENT_SPECS) {
        const obj = sb.global[spec.name];
        if (!obj || typeof obj.VERSION !== 'string' || !/^\d+\.\d+\.\d+$/.test(obj.VERSION)) {
            throw new Error(`Component ${spec.name} (${spec.file}) missing valid 3-segment semver VERSION, got: ${obj && obj.VERSION}`);
        }
        versions[spec.name] = obj.VERSION;
    }
    return versions;
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function syncHeaderVersion(absPath, ver) {
    const raw = fs.readFileSync(absPath, 'utf8');
    const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    let changed = false;
    for (let i = 0; i < Math.min(6, lines.length); i++) {
        if (/\bv\d+\.\d+(?:\.\d+)?\b/.test(lines[i])) {
            const next = lines[i].replace(/\bv\d+\.\d+(?:\.\d+)?\b/, 'v' + ver);
            if (next !== lines[i]) {
                lines[i] = next;
                changed = true;
            }
            break;
        }
    }
    return { changed, content: lines.join(eol) };
}

function replaceVersionForTag(line, tag, ver) {
    const re = new RegExp('(' + escapeRegExp(tag) + '\\s+)v\\d+(?:\\.\\d+){0,2}(?![.\\d])', 'g');
    return line.replace(re, '$1v' + ver);
}

function syncReadme(absPath, versions) {
    const raw = fs.readFileSync(absPath, 'utf8');
    const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let next = line;
        for (const spec of COMPONENT_SPECS) {
            const ver = versions[spec.name];
            for (const tag of spec.docTags) {
                next = replaceVersionForTag(next, tag, ver);
            }
        }
        if (next !== line) {
            lines[i] = next;
            changed = true;
        }
    }
    return { changed, content: lines.join(eol) };
}

function syncRoadmap(absPath, versions) {
    const raw = fs.readFileSync(absPath, 'utf8');
    const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('**P3-2**') < 0) continue;
        let next = lines[i];
        next = replaceVersionForTag(next, 'Epiphy3DFXCore', versions.Epiphy3DFXCore);
        next = replaceVersionForTag(next, 'Epiphy3DFXServer', versions.Epiphy3DFXServer);
        next = replaceVersionForTag(next, 'Epiphy3DFX', versions.Epiphy3DFX);
        if (next !== lines[i]) {
            lines[i] = next;
            changed = true;
        }
    }
    return { changed, content: lines.join(eol) };
}

function syncReadmeLlm(absPath, versions) {
    const raw = fs.readFileSync(absPath, 'utf8');
    const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    let changed = false;

    const llmFileTags = [
        { tag: 'Spec与通用工具.js',          ver: versions.EpiphySpec },
        { tag: 'Epiphy的-空间特效核心.js',   ver: versions.Epiphy3DFXCore },
        { tag: 'Epiphy的-空间特效组件.js',   ver: versions.Epiphy3DFXServer },
        { tag: 'Epiphy的-空间特效渲染器.js', ver: versions.Epiphy3DFX },
        { tag: '平面渲染组件.js',            ver: versions.Epiphy2DSurface },
        { tag: '平面渲染器.js',              ver: versions.Epiphy2DRenderer },
        { tag: '调试组件.js',                ver: versions.EpiphyDebug },
        { tag: 'Epiphy3DFXCore',             ver: versions.Epiphy3DFXCore },
        { tag: 'Epiphy3DFXServer',           ver: versions.Epiphy3DFXServer },
        { tag: 'Epiphy3DFX',                 ver: versions.Epiphy3DFX }
    ];

    for (let i = 0; i < lines.length; i++) {
        // 仅同步 §4 中最新的 P3-2 现行基线行
        if (lines[i].indexOf('`P3-2`') < 0) continue;
        let next = lines[i];
        for (const item of llmFileTags) {
            next = replaceVersionForTag(next, item.tag, item.ver);
        }
        if (next !== lines[i]) {
            lines[i] = next;
            changed = true;
        }
    }
    return { changed, content: lines.join(eol) };
}

function main() {
    const versions = loadRuntimeVersions();
    const drifted = [];

    for (const spec of COMPONENT_SPECS) {
        const absPath = path.join(ROOT_DIR, spec.file);
        const res = syncHeaderVersion(absPath, versions[spec.name]);
        if (res.changed) {
            drifted.push(spec.file);
            if (!CHECK_ONLY) fs.writeFileSync(absPath, res.content, 'utf8');
        }
    }

    const docTasks = [
        { rel: 'README.md',                        fn: syncReadme },
        { rel: 'README_EN.md',                     fn: syncReadme },
        { rel: 'docs/rendering-subsystem-roadmap.md', fn: syncRoadmap },
        { rel: 'README-LLM.md',                    fn: syncReadmeLlm }
    ];
    for (const t of docTasks) {
        const absPath = path.join(ROOT_DIR, t.rel);
        const res = t.fn(absPath, versions);
        if (res.changed) {
            drifted.push(t.rel);
            if (!CHECK_ONLY) fs.writeFileSync(absPath, res.content, 'utf8');
        }
    }

    if (CHECK_ONLY) {
        if (drifted.length > 0) {
            console.error('[SYNC-DOCS CHECK FAILED] Version drift detected in:\n  - ' + drifted.join('\n  - '));
            console.error('Run `npm run sync-docs` to synchronize.');
            process.exit(1);
        }
        console.log('[SYNC-DOCS CHECK OK] All ' + COMPONENT_SPECS.length + ' component headers and 4 docs match runtime VERSIONs.');
        return;
    }

    if (drifted.length === 0) {
        console.log('[SYNC-DOCS OK] Already synchronized (' + COMPONENT_SPECS.length + ' components, 4 docs).');
    } else {
        console.log('[SYNC-DOCS UPDATED] Synchronized ' + drifted.length + ' file(s):\n  - ' + drifted.join('\n  - '));
    }
}

main();
