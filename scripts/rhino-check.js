'use strict';

/**
 * Epiphy KubeJS Rhino 语法与语义偏移检查器
 *
 * 检查流水线（两阶段，绝不静默吞错）：
 *   1. AST 语义偏移守卫（基于 acorn ecmaVersion:2022，无论是否走真 Rhino 均强制执行）：
 *      - 拦截 `??` / `??=`（kube-mods/rhino 解释器 double[] 数值栈 bug）
 *      - 拦截任意 `let` / `const` 声明（含中文/Unicode 标识符，防止循环闭包与 TDZ 语义偏移）
 *      - 拦截正则 `/u`、`/y` 标志
 *   2. 语法编译校验：
 *      - 优先通过真实 `rhino-forge-*.jar`（`dev.latvian.mods.rhino.Context.compileString`）编译；
 *        文件路径列表通过 UTF-8 stdin 传递，规避 Windows 8191 字符命令行长度上限。
 *      - 仅当未发现 Rhino JAR 或本机未安装 JDK/JRE（ENOENT）且未传 `--require-rhino` 时，
 *        自动降级为 acorn AST 完整 kube-mods/rhino 禁区校验（涵盖 `{ x, y }`、`{ [k]: v }`、
 *        默认参数/解构默认值、`...`、`class`、`import/export`、`async/await`、`new.target`、
 *        `0b/0o`/`1_000`/`BigInt`、逻辑赋值与无参 `catch {}`）。
 *      - 若显式指定的 `RHINO_JAR` 不存在，或已找到 JAR 但 `javac`/`java` 返回非零退出码，
 *        直接失败 `exit 1`，绝不静默降级为绿灯。
 *
 * 用法：
 *   node scripts/rhino-check.js                        # 优先真 Rhino，环境缺失时降级 AST
 *   node scripts/rhino-check.js --force-local          # 强制走 acorn AST 校验
 *   node scripts/rhino-check.js --require-rhino        # 强制要求真 Rhino JAR + JDK，否则失败
 *   node scripts/rhino-check.js <file1.js> <file2.js>  # 仅检查指定文件（便于自测）
 *
 * 本地 Rhino JAR 发现顺序（零硬编码个人路径）：
 *   1. 环境变量 `RHINO_JAR`（若设置但文件不存在则直接报错）
 *   2. 环境变量 `MC_MODS_DIR`（扫描目录下 `rhino-forge-*.jar`）
 *   3. 仓库根目录 `.rhino-local.json`（已被 .gitignore 忽略，格式 `{"rhinoJar":"..."}` 或 `{"modsDir":"..."}`）
 *   4. 仓库相对目录 `libs/` 与 `.rhino/`
 */

var fs   = require('fs');
var path = require('path');
var os   = require('os');
var cp   = require('child_process');

var acorn;
try {
    acorn = require('acorn');
} catch (eAcorn) {
    console.error('[rhino-check] 缺少必需的 devDependency `acorn`，请先执行 `npm install` 后重试。');
    process.exit(1);
}

var REPO_ROOT  = path.resolve(__dirname, '..');
var KUBEJS_DIR = path.join(REPO_ROOT, 'kubejs');

var rawArgs       = process.argv.slice(2);
var FORCE_LOCAL   = false;
var REQUIRE_RHINO = false;
var CLI_FILES     = [];

for (var argi = 0; argi < rawArgs.length; argi++) {
    var a = rawArgs[argi];
    if (a === '--force-local') {
        FORCE_LOCAL = true;
    } else if (a === '--require-rhino') {
        REQUIRE_RHINO = true;
    } else if (a && a.charAt(0) !== '-') {
        CLI_FILES.push(path.resolve(process.cwd(), a));
    }
}

function collectJsFiles(dir, out) {
    if (!fs.existsSync(dir)) return out;
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
        var ent  = entries[i];
        var full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            collectJsFiles(full, out);
        } else if (ent.isFile() && ent.name.slice(-3) === '.js') {
            out.push(full);
        }
    }
    return out;
}

function walkAst(node, parent, visitor) {
    if (!node || typeof node !== 'object') return;
    visitor(node, parent);
    for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        if (k === 'loc' || k === 'start' || k === 'end') continue;
        var ch = node[k];
        if (Array.isArray(ch)) {
            for (var i = 0; i < ch.length; i++) {
                if (ch[i] && typeof ch[i] === 'object' && typeof ch[i].type === 'string') {
                    walkAst(ch[i], node, visitor);
                }
            }
        } else if (ch && typeof ch === 'object' && typeof ch.type === 'string') {
            walkAst(ch, node, visitor);
        }
    }
}

function parseAllWithAcorn(files) {
    var parsed = [];
    var parseErrors = [];
    for (var i = 0; i < files.length; i++) {
        var fp  = files[i];
        var rel = path.relative(REPO_ROOT, fp);
        var src = fs.readFileSync(fp, 'utf8');
        try {
            var ast = acorn.parse(src, {
                ecmaVersion: 2022,
                sourceType:  'script',
                locations:   true
            });
            parsed.push({ file: fp, rel: rel, ast: ast });
        } catch (eParse) {
            parseErrors.push(rel + ' [acorn-parse] ' + eParse.message);
        }
    }
    return { parsed: parsed, parseErrors: parseErrors };
}

// 阶段 1：始终执行的 kube-mods/rhino 语义偏移与高危语法守卫（AST 驱动，含 Unicode/中文标识符）
function runSemanticDriftChecks(parsedList) {
    var errors = [];
    for (var i = 0; i < parsedList.length; i++) {
        var item = parsedList[i];
        var rel  = item.rel;
        walkAst(item.ast, null, function (node) {
            var line = (node.loc && node.loc.start) ? node.loc.start.line : 0;
            if (node.type === 'VariableDeclaration' && (node.kind === 'let' || node.kind === 'const')) {
                errors.push(rel + ':' + line + ' [block-scoped ' + node.kind + '] kube-mods/rhino let/const 存在循环闭包与 TDZ 偏移，统一使用 var');
            } else if (node.type === 'LogicalExpression' && node.operator === '??') {
                errors.push(rel + ':' + line + ' [nullish-coalescing (??)] kube-mods/rhino ?? 存在 double[] 数字栈 bug，请改用 != null ? a : b');
            } else if (node.type === 'AssignmentExpression' && node.operator === '??=') {
                errors.push(rel + ':' + line + ' [nullish-assign (??=)] kube-mods/rhino 不支持/存在数值栈风险，请改用显式 != null 判断');
            } else if (node.type === 'Literal' && node.regex != null && /[uy]/.test(String(node.regex.flags || ''))) {
                errors.push(rel + ':' + line + ' [regex /u or /y flag] kube-mods/rhino 仅支持 /g /i /m 正则标志');
            }
        });
    }
    return errors;
}

// 阶段 2（本地降级）：基于 acorn AST 精确核对 docs/kube-mods-rhino-es5-es6-compatibility.md 全部语法禁区
function runAcornRhinoSyntaxCheck(parsedList) {
    var errors = [];
    for (var i = 0; i < parsedList.length; i++) {
        var item = parsedList[i];
        var rel  = item.rel;
        walkAst(item.ast, null, function (node, parent) {
            var line = (node.loc && node.loc.start) ? node.loc.start.line : 0;
            if (node.type === 'Property') {
                if (node.shorthand && parent && parent.type === 'ObjectExpression') {
                    errors.push(rel + ':' + line + ' [rhino-forbid] 不支持对象属性简写 { x, y }');
                }
                if (node.computed) {
                    errors.push(rel + ':' + line + ' [rhino-forbid] 不支持计算属性名 { [k]: v }');
                }
            } else if (node.type === 'SpreadElement' || node.type === 'RestElement') {
                errors.push(rel + ':' + line + ' [rhino-forbid] 不支持 ... 展开/剩余语法');
            } else if (node.type === 'AssignmentPattern') {
                errors.push(rel + ':' + line + ' [rhino-forbid] 不支持函数默认参数或解构默认值');
            } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression' || node.type === 'Super') {
                errors.push(rel + ':' + line + ' [rhino-forbid] 不支持 class / extends / super 语法');
            } else if (
                node.type === 'ImportDeclaration' ||
                node.type === 'ExportNamedDeclaration' ||
                node.type === 'ExportDefaultDeclaration' ||
                node.type === 'ExportAllDeclaration' ||
                node.type === 'ImportExpression'
            ) {
                errors.push(rel + ':' + line + ' [rhino-forbid] 不支持 ES Module import/export');
            } else if (node.type === 'AwaitExpression' || node.async === true) {
                errors.push(rel + ':' + line + ' [rhino-forbid] 不支持 async/await');
            } else if (node.type === 'MetaProperty') {
                errors.push(rel + ':' + line + ' [rhino-forbid] 不支持 new.target / import.meta');
            } else if (node.type === 'AssignmentExpression' && (node.operator === '&&=' || node.operator === '||=' || node.operator === '??=')) {
                errors.push(rel + ':' + line + ' [rhino-forbid] 不支持逻辑赋值运算符 ' + node.operator);
            } else if (node.type === 'CatchClause' && node.param == null) {
                errors.push(rel + ':' + line + ' [rhino-forbid] 不支持无参数 catch {}，请写 catch (e)');
            } else if (node.type === 'Literal') {
                if (node.bigint != null) {
                    errors.push(rel + ':' + line + ' [rhino-forbid] 不支持 BigInt 字面量');
                } else if (typeof node.value === 'number' && typeof node.raw === 'string') {
                    if (/^0[bBoO]/.test(node.raw)) {
                        errors.push(rel + ':' + line + ' [rhino-forbid] 不支持 0b/0o 二进制或八进制字面量');
                    } else if (node.raw.indexOf('_') >= 0) {
                        errors.push(rel + ':' + line + ' [rhino-forbid] 不支持数字分隔符 _');
                    }
                }
            }
        });
    }
    return errors;
}

function scanDirForRhinoJar(dirPath) {
    if (!dirPath || !fs.existsSync(dirPath)) return null;
    try {
        var list = fs.readdirSync(dirPath);
        for (var j = 0; j < list.length; j++) {
            if (/^rhino-forge-.*\.jar$/i.test(list[j])) {
                return path.join(dirPath, list[j]);
            }
        }
    } catch (eDir) { }
    return null;
}

function resolveRhinoJar() {
    if (FORCE_LOCAL) return { status: 'skipped' };

    if (process.env.RHINO_JAR && String(process.env.RHINO_JAR).trim() !== '') {
        var explicitJar = path.resolve(String(process.env.RHINO_JAR).trim());
        if (!fs.existsSync(explicitJar)) {
            return {
                status: 'fatal',
                reason: '环境变量 RHINO_JAR 指向的文件不存在: ' + explicitJar
            };
        }
        return { status: 'found', jarPath: explicitJar };
    }

    var candidateDirs = [];
    if (process.env.MC_MODS_DIR && String(process.env.MC_MODS_DIR).trim() !== '') {
        candidateDirs.push(path.resolve(String(process.env.MC_MODS_DIR).trim()));
    }

    var localCfgPath = path.join(REPO_ROOT, '.rhino-local.json');
    if (fs.existsSync(localCfgPath)) {
        try {
            var cfg = JSON.parse(fs.readFileSync(localCfgPath, 'utf8'));
            if (cfg && typeof cfg.rhinoJar === 'string' && cfg.rhinoJar.trim() !== '') {
                var cfgJar = path.resolve(REPO_ROOT, cfg.rhinoJar.trim());
                if (!fs.existsSync(cfgJar)) {
                    return {
                        status: 'fatal',
                        reason: '.rhino-local.json 中的 rhinoJar 不存在: ' + cfgJar
                    };
                }
                return { status: 'found', jarPath: cfgJar };
            }
            if (cfg && typeof cfg.modsDir === 'string' && cfg.modsDir.trim() !== '') {
                candidateDirs.push(path.resolve(REPO_ROOT, cfg.modsDir.trim()));
            }
        } catch (eCfg) {
            return {
                status: 'fatal',
                reason: '.rhino-local.json 解析失败: ' + eCfg.message
            };
        }
    }

    candidateDirs.push(path.join(REPO_ROOT, 'libs'));
    candidateDirs.push(path.join(REPO_ROOT, '.rhino'));

    for (var i = 0; i < candidateDirs.length; i++) {
        var found = scanDirForRhinoJar(candidateDirs[i]);
        if (found) return { status: 'found', jarPath: found };
    }
    return { status: 'missing' };
}

function runRealRhinoCompile(jarPath, files) {
    var tmpDir    = process.env.RHINO_CACHE_DIR
        ? path.resolve(process.env.RHINO_CACHE_DIR)
        : path.join(os.tmpdir(), 'epiphy_rhino_check_v3');
    fs.mkdirSync(tmpDir, { recursive: true });
    var javaSrc   = path.join(tmpDir, 'RhinoBatchCheck.java');
    var classFile = path.join(tmpDir, 'RhinoBatchCheck.class');
    var javaCode  = [
        'import java.io.*;',
        'import java.nio.file.*;',
        'import java.nio.charset.StandardCharsets;',
        'import dev.latvian.mods.rhino.Context;',
        'public class RhinoBatchCheck {',
        '    public static void main(String[] args) throws Exception {',
        '        BufferedReader br = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));',
        '        Context cx = Context.enter();',
        '        int failed = 0;',
        '        int total = 0;',
        '        String line;',
        '        while ((line = br.readLine()) != null) {',
        '            String path = line.trim();',
        '            if (path.isEmpty()) continue;',
        '            total++;',
        '            try {',
        '                String src = new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);',
        '                cx.compileString(src, path, 1, null);',
        '            } catch (Throwable t) {',
        '                System.err.println("[RHINO FAIL] " + path + " -> " + t.getMessage());',
        '                failed++;',
        '            }',
        '        }',
        '        if (total == 0) {',
        '            System.err.println("[RHINO FAIL] stdin 未收到任何待编译脚本路径");',
        '            System.exit(3);',
        '        }',
        '        if (failed > 0) System.exit(2);',
        '    }',
        '}'
    ].join('\n');

    var needCompile = !fs.existsSync(classFile);
    if (!needCompile) {
        try {
            needCompile = (fs.readFileSync(javaSrc, 'utf8') !== javaCode);
        } catch (eR) { needCompile = true; }
    }

    var javacBin = process.env.RHINO_JAVAC_BIN || 'javac';
    var javaBin  = process.env.RHINO_JAVA_BIN  || 'java';

    if (needCompile) {
        fs.writeFileSync(javaSrc, javaCode, 'utf8');
        var jc = cp.spawnSync(javacBin, ['-encoding', 'UTF-8', '-cp', jarPath, '-d', tmpDir, javaSrc], { encoding: 'utf8' });
        if (jc.error) {
            if (jc.error.code === 'ENOENT') {
                return { status: 'no-jdk', reason: '未检测到 ' + javacBin + ' (ENOENT)' };
            }
            return { status: 'toolchain-error', stderr: 'javac 启动异常: ' + jc.error.message };
        }
        if (jc.status !== 0) {
            return {
                status: 'toolchain-error',
                stderr: 'javac 编译 RhinoBatchCheck 失败 (exit ' + jc.status + '):\n' + (jc.stderr || jc.stdout || '').trim()
            };
        }
    }

    var sep = process.platform === 'win32' ? ';' : ':';
    var stdinPayload = files.join('\n') + '\n';
    var run = cp.spawnSync(javaBin, ['-Dfile.encoding=UTF-8', '-cp', tmpDir + sep + jarPath, 'RhinoBatchCheck'], {
        encoding: 'utf8',
        input:    stdinPayload,
        maxBuffer: 16 * 1024 * 1024
    });
    if (run.error) {
        if (run.error.code === 'ENOENT') {
            return { status: 'no-jdk', reason: '未检测到 ' + javaBin + ' (ENOENT)' };
        }
        return { status: 'toolchain-error', stderr: 'java 启动异常: ' + run.error.message };
    }
    if (run.status !== 0) {
        return {
            status: 'compile-error',
            stderr: (run.stderr || run.stdout || ('RhinoBatchCheck exit ' + run.status)).trim()
        };
    }
    return { status: 'ok' };
}

function main() {
    var files = (CLI_FILES.length > 0) ? CLI_FILES.slice() : collectJsFiles(KUBEJS_DIR, []).sort();
    if (files.length === 0) {
        console.error('[rhino-check] 未找到任何待检查的 .js 脚本！');
        process.exit(1);
    }

    // 1. AST 解析 + 强制执行 kube-mods/rhino 语义偏移守卫（?? / let / const / regex u|y）
    var parsedRes = parseAllWithAcorn(files);
    if (parsedRes.parseErrors.length > 0) {
        console.error('[rhino-check] AST 语法解析失败:');
        for (var pi = 0; pi < parsedRes.parseErrors.length; pi++) console.error('  - ' + parsedRes.parseErrors[pi]);
        process.exit(1);
    }

    var driftErrors = runSemanticDriftChecks(parsedRes.parsed);
    if (driftErrors.length > 0) {
        console.error('[rhino-check] 检测到 kube-mods/rhino 语义偏移禁区写法:');
        for (var di = 0; di < driftErrors.length; di++) console.error('  - ' + driftErrors[di]);
        process.exit(1);
    }

    // 2. 优先使用真实 Rhino JAR 编译核验；仅环境缺失时降级为 acorn AST 禁区校验
    var jarInfo = resolveRhinoJar();
    if (jarInfo.status === 'fatal') {
        console.error('[rhino-check] Rhino 配置错误: ' + jarInfo.reason);
        process.exit(1);
    }

    if (jarInfo.status === 'found') {
        var realRes = runRealRhinoCompile(jarInfo.jarPath, files);
        if (realRes.status === 'ok') {
            console.log('[RHINO REAL OK] Compiled ' + files.length + '/' + files.length + ' scripts via ' + path.basename(jarInfo.jarPath) + ' (+ acorn semantic-drift guard)');
            return;
        }
        if (realRes.status === 'toolchain-error' || realRes.status === 'compile-error') {
            console.error('[rhino-check] 真实 Rhino 校验失败（已存在 JAR，禁止静默降级）:');
            console.error(realRes.stderr);
            process.exit(1);
        }
        // realRes.status === 'no-jdk'
        if (REQUIRE_RHINO) {
            console.error('[rhino-check] --require-rhino 已开启，但缺少 JDK/JRE: ' + realRes.reason);
            process.exit(1);
        }
        console.warn('[rhino-check] ' + realRes.reason + '，自动降级为本地 acorn AST 校验...');
    } else if (REQUIRE_RHINO) {
        console.error('[rhino-check] --require-rhino 已开启，但未找到 rhino-forge-*.jar（请设置 RHINO_JAR 或 MC_MODS_DIR）');
        process.exit(1);
    }

    var astErrors = runAcornRhinoSyntaxCheck(parsedRes.parsed);
    if (astErrors.length > 0) {
        console.error('[rhino-check] 本地降级校验 (local-acorn-ast) 失败:');
        for (var ei = 0; ei < astErrors.length; ei++) console.error('  - ' + astErrors[ei]);
        process.exit(1);
    }
    var fallbackNote = FORCE_LOCAL ? 'forced local mode' : 'rhino-forge jar or JDK not found; fallback active';
    console.log('[RHINO LOCAL OK] Checked ' + files.length + '/' + files.length + ' scripts via local-acorn-ast (' + fallbackNote + ')');
}

main();
