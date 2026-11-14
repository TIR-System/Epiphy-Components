# `kube-mods/rhino` ES5 / ES6 兼容性与语义偏移说明

> 分析依据：`kube-mods/rhino` 架构与本地实包 [`rhino-forge-2001.2.3-build.10.jar`](file:///E:/Minecraft/%5B1.20.1-%E6%B5%8B%E8%AF%95%5D/.minecraft/mods/rhino-forge-2001.2.3-build.10.jar)（共 446 个 `.class` 文件）的字节码结构检查（`javap`）与解释器实测结果。

---

## 一、引擎底座总览

`kube-mods/rhino` 是基于 Mozilla Rhino 深度裁剪与魔改的分支（包名 `dev.latvian.mods.rhino`），与上游标准 Rhino 及标准 ECMAScript 存在结构性差异：

1. **纯解释器执行**：移除了 `Codegen` / JVM 字节码优化器包，全部脚本由 `Interpreter` 解释执行。
2. **无语言版本/特性开关**：移除了标准 Rhino 的 `Context.VERSION_*`、`Context.FEATURE_*` 与 `ContextFactory`；`Context` 中仅保留 `isTopLevelStrict` / `isStrictMode()`。
3. **固定混合方言**：同时混杂了：
   - 大部分 ES5 语法与内置 API；
   - 部分 Mozilla `VERSION_ES6` 特性；
   - 已废弃的 Mozilla JS 1.7 / 1.8 遗留语法；
   - 少数回填的 ES2020 运算符（`?.`、`??`、`**`）；
   - KubeJS 自定义扩展（如 `String.prototype` 的 `namespace`/`path`、魔改的 `JSON.stringify` 等）。

---

## 二、快速结论表

| 特性 / 类别 | 状态 | 说明 / 实测表现 |
| --- | --- | --- |
| ES5 核心对象 / 数组 / `bind` / 访问器 | ✅ 可用 | `Object.defineProperty`、`Array.prototype.map/reduce`、`Function.prototype.bind`、`get`/`set` 等正常 |
| ES5 严格模式基础校验 | ✅ 可用 | 禁 `with`、禁重名形参、禁 `010` 旧八进制、未声明赋值抛 `ReferenceError`、禁 `arguments.callee`、形参/实参解绑 |
| ES5 `'use strict'` 的 `this` | ⚠️ 偏移 | 非方法调用中 `this` 仍为 `[object Object]`，不是 `undefined` |
| ES5 `'use strict'` 下的 `eval` | ⚠️ 偏移 / 禁间接调用 | 直接 `eval` 会把 `var` 泄漏到外层函数；间接 `eval` 直接抛 `RuntimeException: eval is not allowed!` |
| `JSON.stringify` | ⚠️ 魔改偏移 | 对象上的 `undefined` 变成 `null`，函数被序列化为反射成员列表，整数输出 `1.0` |
| ES6 箭头函数 / 模板字符串 / `function*` / `for...of` | ✅ 可用 | 词法 `this`/`arguments`、标签模板 `.raw`、ES6 生成器与迭代器正常 |
| ES6 `Map` / `Set` / `WeakMap` / `WeakSet` / `Symbol` | ✅ 可用 | 集合类、自定义 `[Symbol.iterator]`、`Symbol.for`、`getOwnPropertySymbols` 正常 |
| ES6 `Object` / `Array` / `String` / `Number` / `Math` 新方法 | ✅ 较全 | `assign`/`is`/`entries`/`values`、`from`/`of`/`find`/`includes`、`padStart`/`trimStart`/`codePointAt` 等均在 |
| ES6 `let` / `const` | ⚠️ 严重偏移 | **无 TDZ**、**`for(let)` 无每轮独立绑定**、`const` 可无初始值且非严格模式重写静默失败 |
| ES6 `{ fn() {} }` 对象方法简写 | ✅ 可用 | `var o = { fn(x) { return x; } }` 正常 |
| ES6 `{ x, y }` 对象属性简写 / `{ [k]: v }` 计算属性 | ❌ 缺失 | 分别报 `SyntaxError: invalid object initializer` 与 `invalid property id` |
| ES6 解构赋值（基础与嵌套） | ⚠️ 部分可用 | `{a: {b}}`、`[a, , c]`、形参解构可用；**不支持解构默认值**与**不支持 `...rest`** |
| ES6 `class` / `extends` / `super` / `import` / `export` | ❌ 缺失 | `class`/`export`/`import` 均直接报保留字语法错误；无模块加载器 |
| ES6 `...`（展开与剩余参数）/ 函数默认参数 / `new.target` | ❌ 缺失 | 全部语法报错 |
| ES6 `Promise` / `Proxy` / `Reflect` / `ArrayBuffer` / TypedArray | ❌ 缺失 | 均为 `undefined`（也无 `async`/`await`、`BigInt`） |
| ES6 正则 `u` / `y` 标志与 `.flags` | ❌ 缺失 | `new RegExp('a', 'u')` / `'y'` 直接报 `invalid flag`；仅支持 `g`/`i`/`m` |
| ES2020 `?.` 与 `**` | ✅ 可用 | `obj?.a?.b` 与 `2 ** 3` 正常 |
| ES2020 `??`（空值合并） | ❌ 致命 Bug | 解释器未同步 `double[]` 数字栈，`null ?? 9`、`undefined ?? 9` 等数值兜底会错误返回 **`0`** 或残留数值 |

---

## 三、ES5 细节：缺失与语义偏移

### 1. 完整可用的 ES5 行为
- **对象属性描述符与冻结保护**：
  - `Object.create`、`defineProperty`、`defineProperties`、`getOwnPropertyDescriptor`、`getOwnPropertyNames`、`keys`、`freeze`、`seal`、`preventExtensions`、`getPrototypeOf`、`isExtensible`、`isSealed`、`isFrozen`。
  - 只读或不可配置属性在 `'use strict'` 下修改/删除会抛 `TypeError`；非严格模式下写操作静默忽略，`delete` 返回 `false`。
- **`arguments` 联动与限制**：
  - 非严格模式下 `(function(a){ arguments[0] = 99; return a; })(1)` 返回 `99`（保持别名联动）；
  - `'use strict'` 下同测试返回 `1`（解除联动），访问 `arguments.callee` 抛 `TypeError`。
- **严格模式基础语法约束**：
  - 禁止 `with`（非严格模式仍可使用）、禁止重名形参、禁止 `010` 旧八进制字面量、禁止给未声明变量赋值（抛 `ReferenceError`）。
- **其他标准 ES5 行为**：
  - `undefined` / `NaN` / `Infinity` 全局只读；
  - `parseInt('010')` 返回 `10`（不默认按八进制解析）；
  - `Array.isArray` 与 `forEach`/`map`/`filter`/`reduce`/`reduceRight`/`every`/`some`/`indexOf`/`lastIndexOf` 均存在，稀疏数组 `.map` 保留空洞；
  - `Function.prototype.bind` 正常工作（含作为构造函数 `new B()`）；
  - 对象字面量尾部逗号、属性 `get`/`set` 访问器正常。

### 2. ES5 缺失与偏移项
1. **`'use strict'` 下的独立函数调用 `this` 不为 `undefined`**
   - 实测：`(function(){ 'use strict'; return String(this) })()` 返回 `"[object Object]"`，`this === undefined` 为 `false`。
   - 偏移：标准 ES5 严格模式下非方法调用的 `this` 应保持 `undefined`。
2. **`'use strict'` 下的直接 `eval` 没有独立变量环境**
   - 实测：`(function(){ 'use strict'; eval('var sev = 123;'); return typeof sev; })()` 返回 `"number"`。
   - 偏移：严格模式 `eval` 内部 `var` 声明仍泄漏到了外层函数作用域。
3. **间接 `eval` 被彻底禁用**
   - 直接调用 `eval('k')` 会由编译/运行期走 `ScriptRuntime.evalSpecial`，可以读取局部作用域并返回结果；
   - 间接调用（如 `(0, eval)('1+1')` 或 `var e = eval; e(...)`）会落入 `NativeGlobal.js_eval`，字节码中写死了直接抛出 `new RuntimeException("eval is not allowed!")`。
4. **`'use strict'` 块内函数声明泄漏**
   - 实测：`(function(){ 'use strict'; if (true) { function bf() { return 1; } } return typeof bf; })()` 返回 `"function"`。
5. **`JSON.stringify` 被 KubeJS 魔改**
   - 实测：`JSON.stringify({a:1, b:undefined, c: function(){}})` 返回 `{"a":1.0,"b":null,"c":["class dev.latvian.mods.rhino.InterpretedFunction", ...]}`。
   - 偏移：不仅保留并转换了 `undefined`（变为 `null`）与函数键（反射为 Java 类成员列表），数字 `1` 也被序列化为 `1.0`。

---

## 四、ES6 细节：实现、缺失与语义偏移

### 1. 已实现的 ES6（及附带少量 ES2016/2017）特性

#### 语法层面
- **箭头函数 `=>`**：词法捕获外层 `this` 和 `arguments`；不可使用 `new` 调用；不可作生成器。
- **模板字符串与标签模板**：`` `x=${1+2}` `` 与 `` tag`a\n:${5}` ``（支持 `.raw`）。
- **基础解构赋值**：`var {a, b} = obj`、嵌套 `var {a: {b}} = obj`、`var [x, , z] = arr`、函数形参解构 `function({a, b})`。
- **对象方法简写**：`{ m(x) { return x; } }`。
- **`for...of` 循环**：支持数组、字符串、`Map`/`Set` 以及自定义 `[Symbol.iterator]`。
- **生成器 `function*`**：`yield` 与 `yield*`（基于 `ES6Generator` / `ES6Iterator`）。
- **`Symbol`**：`Symbol()`、`Symbol.for()`、`Symbol.keyFor()`、`Symbol.iterator`、`Symbol.toStringTag`、`Symbol.toPrimitive`、`Object.getOwnPropertySymbols()`（`Object.keys` 会正确忽略 Symbol 键）。

#### 内置类与静态/原型方法（由 `javap -constants` 与实测确认）
- **集合**：`Map`、`Set`、`WeakMap`、`WeakSet`。
- **`Object`**：`assign`、`is`、`setPrototypeOf`、`getOwnPropertySymbols`、以及 ES2017 的 `entries` / `values`；`Object.keys('ab')` 遵循 ES6 将原始字符串装箱返回 `0,1`。
- **`Array`**：`Array.from`、`Array.of`；原型 `find`、`findIndex`、`fill`、`copyWithin`、`keys`、`values`、`entries`、`[Symbol.iterator]`，以及 ES2016 的 `includes`（`[NaN].includes(NaN)` 为 `true`）。
- **`String`**：`String.fromCodePoint`、`String.raw`；原型 `codePointAt`、`includes`、`startsWith`、`endsWith`、`repeat`、`normalize`、`[Symbol.iterator]`，以及 ES2017 的 `padStart`、`padEnd`、`trimStart`、`trimEnd`（另有 KubeJS 自定义 `namespace` / `path` 等）。
- **`Number`**：`Number.isFinite`、`Number.isNaN`、`Number.isInteger`、`Number.isSafeInteger`、`Number.MAX_SAFE_INTEGER`、`Number.parseFloat`、`Number.parseInt`（`Number.isFinite('1')` 为 `false`，`Number.isNaN('NaN')` 为 `false`）。
- **`Math`**：`cbrt`、`cosh`、`expm1`、`hypot`、`log1p`、`log10`、`log2`、`sinh`、`tanh`、`imul`、`trunc`、`acosh`、`asinh`、`atanh`、`sign`、`fround`、`clz32`。

### 2. 缺失的 ES6（及常见相邻版本）特性

- **`class` / `extends` / `super`**：无相应 AST `Token`，`class` 直接报 `identifier is a reserved word: class`。
- **ES Modules（`import` / `export`）**：`Token` 类中虽留有 `EXPORT = 111`、`IMPORT = 112` 常量，但没有模块加载器，解析直接报 `identifier is a reserved word: export/import`。
- **`...` 展开与剩余语法**：
  - 数组展开 `[...arr]`、调用展开 `fn(...args)` 报 `syntax error`；
  - 剩余参数 `function(...args)` 报 `missing formal parameter`；
  - 对象展开/解构剩余 `{a, ...rest}` 报 `invalid property id`，数组解构剩余 `[a, ...rest]` 报 `syntax error`。
- **函数默认参数**：`function(a = 1)` 报 `missing ) after formal parameters`。
- **解构默认值**：`var {a = 10} = {}` 解析报错（`Messages.properties` 内建提示 `Default values in destructuring declarations are not supported`）。
- **对象字面量属性简写与计算属性名**：
  - `{ x, y }` 报 `SyntaxError: invalid object initializer`（与可用的 `{ m() {} }` 形成割裂）；
  - `{ [key]: 99 }` 报 `invalid property id`。
- **`new.target`**：报 `syntax error`。
- **二进制/八进制新字面量**：`0b101`、`0o77`（以及 `1_000` 数字分隔符）不支持。
- **正则新标志与属性**：`/a/u`、`/a/y` 均报 `SyntaxError: invalid flag after regular expression`；`/a/i.flags`、`.sticky`、`.unicode` 均为 `undefined`（仅支持 `g`、`i`、`m`）。
- **核心异步与元编程内置对象**：
  - 无 `Promise`（也无 `async`/`await`）；
  - 无 `Proxy` 与 `Reflect`；
  - 无 `ArrayBuffer`（及 TypedArray）与 `BigInt`。
- **常见后续标准方法缺失**：`Object.getOwnPropertyDescriptors`、`Object.fromEntries`、`Array.prototype.flat`（及 `flatMap` / `at` 不在 `NativeArray` 方法列表中）。
- **函数 `.name` 自动推导缺失**：`var ff = function(){}; var om = { m(){} }; [ff.name, om.m.name, (() => {}).name]` 全部返回空字符串 `""`。

### 3. 最危险的 ES6 语义偏移

1. **`let` / `const` 没有 TDZ（暂时性死区）**
   - 实测在 `let lx = 5;` 之前直接读取 `lx` 或执行 `typeof lx`，**不会抛 `ReferenceError`**，而是返回 `undefined`。
2. **`for (let ...)` / `for (let ... of ...)` / `for (let ... in ...)` 没有每次迭代独立绑定**
   - 实测以下三类循环中创建的闭包全部共享同一个最终值：
     - `for (let i = 0; i < 3; i++) fs.push(() => i)` → `3,3,3`；
     - `for (let v of [1, 2, 3]) fs.push(() => v)` → `3,3,3`；
     - `for (let k in {x:1, y:2}) fs.push(() => k)` → `y,y`；
     - 实测 `for (let i = 0; i < 3; i++) { let j = i; fs.push(() => i + ':' + j); }` 输出 **`3:0,3:1,3:2`**（头部 `i` 全程共享成 `3`，只有块体内的 `let j = i` 在每轮重新赋值得到 `0,1,2`）。
3. **单语句 `if` 允许裸写 `let`/`const` 且向外部泄漏**
   - 实测 `if (true) let lsx = 1; lsx` 与 `if (true) const csx = 1; csx` 不抛 `SyntaxError` 且外层直接可读到 `1`（只有带花括号的 `if (true) { let ib = 1; }` 才会把作用域锁在块内）。
4. **`const` 允许缺省初始值，且非严格模式下重赋值静默失败**
   - 实测 `const c;` 可通过编译且不报错；
   - 非严格模式下对 `const` 重新赋值**不抛 `TypeError`**，而是静默忽略、保持原值（仅在 `'use strict'` 下会抛 `TypeError: Cannot modify readonly property: c.`）。
   - 同块重复声明仍正常报错（`TypeError: redeclaration of variable/const ...`）。
5. **混入 Mozilla JS 1.7 / 1.8 遗留语法**
   - 支持老式作用域表达式 `let (lx = 3) lx + 1`（`LETEXPR`）；
   - 普通函数（不带 `*`）内只要写了 `yield(...)` 就会自动变成 `ES6Generator`（旧式生成器），且部分表达式位置的 `yield` 仍要求强制加括号（`yield expression must be parenthesized.`）。

---

## 五、特别警示：ES2020 `??`（空值合并）的解释器栈 Bug

虽然 `kube-mods/rhino` 在 `Token` 中加入了 `OPTIONAL_CHAINING`（`?.`）、`POW`（`**`）和 `NULLISH_COALESCING`（`??`），但 `??` 在解释器中存在严重的数值栈损坏 Bug：

- 字节码检查 `Interpreter.doNullishCoalescing(Interpreter.CallFrame, Object[], double[], int)` 显示：
  Rhino 解释器用 `Object[]` 栈配合 `UniqueTag.DOUBLE_MARK` + 平行 `double[]` 数组存放 JS 数字。该方法只把 `(LHS == null || Undefined.isUndefined(LHS)) ? RHS : LHS` 写回 `Object[]` 参数的 `sp - 1` 槽位，**传入的 `double[]` 参数在方法体内完全未被读取或同步到 `sp - 1`**。
- 实测结果：
  - `null ?? 9` → **`0`**
  - `undefined ?? 9` → **`0`**
  - `var nv = null; nv ?? 9` → **`0`**
  - `({a: null}).a ?? 9` → **`0`**
  - `'' + (null ?? 9)` → **`0`**
  - 在前置计算占据栈槽的复杂表达式 `({a:{b:7}})?.a?.b + ',' + (null ?? 9) + ',' + (2 ** 3)` 中，甚至会读到相邻槽位残留数字 `1`，输出 `7,1,8`。
  - 相反，左值非空或兜底值为非数字时（如 `false ?? 9` → `false`、`'' ?? 'fallback'` → `''`、`({a: 42}).a ?? 9` → `42`）则不会立刻踩中该槽位覆写。

---

## 六、项目编码落地建议

1. **安全语法基准**：把业务脚本收敛在 **“严格模式兼容的 ES5 子集 + `const`/`let`（仅放在 `{}` 块内，不依赖 TDZ 与循环闭包独立性）+ 箭头函数 + 模板字符串 + `Map`/`Set`”**。
2. **明确禁用清单**：
   - 不要使用 `{ x, y }` 属性简写与 `{ [k]: v }` 计算属性名（对象字面量保持 `k: v` 完整写法）；
   - 不要在 `for (let ...)` 头部内直接创建依赖循环变量的闭包（需要捕获循环变量时继续用 IIFE / 显式传参，或明确用 ES5 风格循环结构）；
   - 不要使用 `??` 做数值默认值兜底（请显式写 `(v !== null && v !== undefined) ? v : fallback` 或在确定范围时处理 `== null`）；
   - 不要依赖 `'use strict'` 的 `this === undefined`、严格模式 `eval` 隔离、间接 `eval`、以及标准 `JSON.stringify` 对函数/`undefined` 的静默丢弃规则；
   - 不要使用 `class`、`...`、默认参数、`Promise`、`Proxy`、`Reflect`、正则 `/u`/`/y`。
