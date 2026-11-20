// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
'use strict'

/**
 * Epiphy KubeJS 统一测试运行器
 *
 * 用法：
 *   node tests/run.js                     # 运行 tests/suites/*.test.js 全部套件
 *   node tests/run.js renderer            # 仅运行文件名包含 "renderer" 的套件
 *   node tests/run.js --filter "68."      # 仅运行测试名包含 "68." 的用例
 *   node tests/pure_functions.test.js     # 向后兼容转发入口，等价于 node tests/run.js
 */

var fs      = require('fs')
var path    = require('path')
var harness = require('./helpers/harness')

var SUITES_DIR = path.join(__dirname, 'suites')

var rawArgs     = process.argv.slice(2)
var suiteFilter = []
var nameFilter  = ''

for (var ai = 0; ai < rawArgs.length; ai++) {
    var a = rawArgs[ai]
    if (a === '--filter' && rawArgs[ai + 1]) {
        nameFilter = String(rawArgs[++ai]).toLowerCase()
    } else if (a && a.indexOf('--filter=') === 0) {
        nameFilter = a.slice('--filter='.length).toLowerCase()
    } else if (a && a.charAt(0) !== '-') {
        suiteFilter.push(a.toLowerCase())
    }
}

var SUITE_ORDER = [
    'spec_and_pure.test.js',
    'server_core_and_persistence.test.js',
    'permission_valve.test.js',
    'block_tracker_and_world_ops.test.js',
    'audio.test.js',
    'surface_and_renderer.test.js',
    'startup_and_tooling.test.js'
]

var discovered = fs.readdirSync(SUITES_DIR)
    .filter(function (f) { return f.slice(-8) === '.test.js' })
    .sort(function (a, b) {
        var ia = SUITE_ORDER.indexOf(a)
        var ib = SUITE_ORDER.indexOf(b)
        if (ia >= 0 && ib >= 0) return ia - ib
        if (ia >= 0) return -1
        if (ib >= 0) return 1
        return a < b ? -1 : (a > b ? 1 : 0)
    })

var selectedSuites = discovered.filter(function (f) {
    if (suiteFilter.length === 0) return true
    var lf = f.toLowerCase()
    for (var i = 0; i < suiteFilter.length; i++) {
        if (lf.indexOf(suiteFilter[i]) >= 0) return true
    }
    return false
})

if (selectedSuites.length === 0) {
    console.error('[test-runner] 未匹配到任何测试套件: ' + suiteFilter.join(', '))
    process.exit(1)
}

var tests = []
function registerTest(suiteName) {
    return function test(name, fn) {
        tests.push({ suite: suiteName, name: name, fn: fn })
    }
}

for (var si = 0; si < selectedSuites.length; si++) {
    var suiteFile = selectedSuites[si]
    var suiteMod  = require(path.join(SUITES_DIR, suiteFile))
    if (typeof suiteMod !== 'function') {
        console.error('[test-runner] 测试套件必须导出 register(test, harness) 函数: ' + suiteFile)
        process.exit(1)
    }
    suiteMod(registerTest(suiteFile), harness)
}

var toRun = tests.filter(function (t) {
    if (!nameFilter) return true
    return t.name.toLowerCase().indexOf(nameFilter) >= 0 || t.suite.toLowerCase().indexOf(nameFilter) >= 0
})

if (toRun.length === 0) {
    console.error('[test-runner] 未匹配到任何测试用例 (filter=' + nameFilter + ')')
    process.exit(1)
}

var passed = 0
for (var i = 0; i < toRun.length; i++) {
    var t = toRun[i]
    try {
        t.fn()
        passed++
        console.log('[PASS] ' + t.name)
    } catch (err) {
        console.error('[FAIL] [' + t.suite + '] ' + t.name)
        console.error(err && err.stack ? err.stack : err)
        process.exitCode = 1
    }
}

console.log('Summary: ' + passed + '/' + toRun.length + ' passed (' + selectedSuites.length + ' suites)')
