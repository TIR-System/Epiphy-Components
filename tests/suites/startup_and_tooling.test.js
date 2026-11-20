// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
'use strict'

module.exports = function registerSuite(test, h) {
    var assert                    = h.assert
    var fs                        = h.fs
    var path                      = h.path
    var vm                        = h.vm
    var ROOT_DIR                  = h.ROOT_DIR
    var SPEC_PATH                 = h.SPEC_PATH
    var LOG_PATH                  = h.LOG_PATH
    var SERVER_BASE_PATH          = h.SERVER_BASE_PATH
    var TRACKER_PATH              = h.TRACKER_PATH
    var VALVE_PATH                = h.VALVE_PATH
    var DEBUG_PATH                = h.DEBUG_PATH
    var BUGFIX_PATH               = h.BUGFIX_PATH
    var DANMAKU_PATH              = h.DANMAKU_PATH
    var AUDIO_PATH                = h.AUDIO_PATH
    var RENDERER_PATH             = h.RENDERER_PATH
    var AUDIO_CLIENT_PATH         = h.AUDIO_CLIENT_PATH
    var createKubeSandbox         = h.createKubeSandbox
    var attachConsoleCapture      = h.attachConsoleCapture
    var runScriptIn               = h.runScriptIn
    var loadStartupBase           = h.loadStartupBase
    var loadServerBase            = h.loadServerBase
    var plain                     = h.plain
    var makeMockWorld             = h.makeMockWorld
    var attachSandboxEventHooks   = h.attachSandboxEventHooks
    var makeNodeBackedJavaSandbox = h.makeNodeBackedJavaSandbox
    var shared                    = h.getSharedDefaultSandbox()
    var sandbox                   = shared.sandbox
    var Valve                     = shared.Valve
    var Danmaku                   = shared.Danmaku
    var pure                      = shared.pure
    test('client modules: degrade gracefully when EpiphySpec/EpiphyProtocol is absent and still fail-closed reject mismatched packets', function () {
        function makeClientDegradedSandbox() {
            var warns  = []
            var errors = []
            var netHandlers   = {}
            var paintHandlers = []
            var tickHandlers  = []
            var draws         = []
            var noop          = function () {}
            var sb = {
                console: {
                    info:  noop,
                    warn:  function (m) { warns.push(String(m)) },
                    error: function (m) { errors.push(String(m)) },
                    debug: noop,
                    log:   noop
                },
                ClientEvents: {
                    loggedOut:   noop,
                    loggedIn:    noop,
                    paintScreen: function (fn) { paintHandlers.push(fn) },
                    tick:        function (fn) { tickHandlers.push(fn) }
                },
                NetworkEvents: {
                    dataReceived: function (ch, fn) { netHandlers[ch] = fn }
                },
                Java: { loadClass: function () { return null } },
                Text: { of: function (s) { return { string: String(s), getVisualOrderText: function () { return String(s) } } } },
                global: {}
            }
            sb.globalThis = sb
            vm.createContext(sb)
            return {
                sb: sb,
                warns: warns,
                errors: errors,
                netHandlers: netHandlers,
                paintHandlers: paintHandlers,
                tickHandlers: tickHandlers,
                draws: draws
            }
        }

        // 1. 音频客户端无 startup 前置时平滑降级，仍严格拒收旧版本包
        var auEnv = makeClientDegradedSandbox()
        runScriptIn(auEnv.sb, AUDIO_CLIENT_PATH)
        assert.ok(auEnv.warns.some(function (w) { return w.indexOf('Epiphy的-Spec与通用工具.js') >= 0 }))
        assert.ok(auEnv.sb.global.EpiphyAudioClient != null)
        assert.ok(typeof auEnv.netHandlers['epiphy:audio'] === 'function')
        auEnv.netHandlers['epiphy:audio']({ data: { proto: 4, action: 'play', snd: 'minecraft:ui.button.click' } })
        assert.strictEqual(auEnv.errors.length, 1, 'degraded audio client must fail-closed reject mismatched proto=4 packet')
        auEnv.netHandlers['epiphy:audio']({ data: { proto: 5, action: 'play', h: 'degraded_h1', snd: 'minecraft:ui.button.click', vol: 1.2 } })
        assert.strictEqual(auEnv.errors.length, 1, 'degraded audio client must accept valid proto=5 packet without errors')
        assert.strictEqual(auEnv.sb.global.EpiphyAudioClient.count(), 1, 'degraded audio client must queue valid proto=5 action')

        // 2. 弹幕客户端无 startup 前置时可接收 v5 包并完成绘制，同时拒收错误版本包
        var dmEnv = makeClientDegradedSandbox()
        runScriptIn(dmEnv.sb, RENDERER_PATH)
        assert.ok(dmEnv.warns.some(function (w) { return w.indexOf('Epiphy的-Spec与通用工具.js') >= 0 }))
        assert.ok(dmEnv.sb.global.ScreenDanmakuClient != null)
        assert.ok(typeof dmEnv.netHandlers['epiphy:screen_danmaku'] === 'function')

        // 错误版本包被 fail-closed 拒收，不入队
        dmEnv.netHandlers['epiphy:screen_danmaku']({ data: { proto: 4, title: 'bad_proto' } })
        assert.strictEqual(dmEnv.errors.length, 1, 'degraded renderer must fail-closed reject mismatched proto=4 packet')

        var mockEvent = {
            width: 854,
            height: 480,
            level: 'minecraft:overworld',
            font: {
                width: function (s) { return String(s || '').length * 6 },
                drawInBatch: function (txt) { dmEnv.draws.push(String(txt && txt.string ? txt.string : txt)) }
            },
            text: function (txt) { dmEnv.draws.push(String(txt && txt.string ? txt.string : txt)) },
            graphics: { bufferSource: function () { return {} }, flush: function () {} },
            getMatrix: function () { return {} },
            push: function () {},
            pop: function () {},
            translate: function () {},
            scale: function () {},
            rotateDeg: function () {},
            blend: function () {}
        }
        dmEnv.paintHandlers[0](mockEvent)
        assert.strictEqual(dmEnv.draws.length, 0, 'rejected proto=4 packet must produce 0 draws')

        // 正常 v5 包可触发绘制（含字符串优先级与布尔字段解析）
        dmEnv.netHandlers['epiphy:screen_danmaku']({
            data: { proto: 5, title: 'DegradedOK', priority: 'urgent', typewriter: 'false', shadow: false, stay: 40 }
        })
        dmEnv.paintHandlers[0](mockEvent)
        assert.strictEqual(dmEnv.errors.length, 1, 'degraded renderer must paint valid proto=5 danmaku without draw errors')
        assert.ok(dmEnv.draws.length >= 1, 'degraded renderer must still render valid proto=5 danmaku')
        assert.ok(dmEnv.draws.some(function (s) { return s.indexOf('DegradedOK') >= 0 }), 'degraded renderer must draw payload text')
    })

    // ----------------------------------------------------------------------------
    // 38. Client java.lang.System Class Filter: silent probe produces zero WARN
    // ----------------------------------------------------------------------------
    test('Client loadJavaClass(java.lang.System, true): class filter rejection emits zero WARN', function () {
        function makeClientSb() {
            var sb = {
                console: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, log: function () {} },
                ClientEvents:  { tick: function () {}, loggedIn: function () {}, loggedOut: function () {}, paintScreen: function () {} },
                NetworkEvents: { dataReceived: function () {} },
                Client:        { minecraft: null },
                Java: {
                    loadClass: function (name) {
                        if (name === 'java.lang.System') {
                            throw new Error('Class java.lang.System is not allowed by class filter!')
                        }
                        return null
                    }
                },
                global: {}
            }
            sb.globalThis = sb
            vm.createContext(sb)
            loadStartupBase(sb)
            return sb
        }

        var dmSb = makeClientSb()
        var dmCon = attachConsoleCapture(dmSb)
        runScriptIn(dmSb, RENDERER_PATH)
        assert.strictEqual(
            dmCon.warns.some(function (w) { return w.indexOf('java.lang.System') >= 0 }),
            false,
            'ScreenDanmakuClient must not warn when java.lang.System is blocked by class filter'
        )

        var auSb = makeClientSb()
        var auCon = attachConsoleCapture(auSb)
        runScriptIn(auSb, AUDIO_CLIENT_PATH)
        assert.strictEqual(
            auCon.warns.some(function (w) { return w.indexOf('java.lang.System') >= 0 }),
            false,
            'EpiphyAudioClient must not warn when java.lang.System is blocked by class filter'
        )
    })

    test('hidden items: epiphy:chaos_crystal avoids createCompositeState(boolean) EnumTypeWrapper trap across Mojmap, no-AT, and SRG modes', function () {
        var HIDDEN_PATH = path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', 'Epiphy的小玩意-原版_其他Mod的隐藏物品.js')

        function runHiddenItemsCase(useRemappedMojmap, exposeOutlineEnum) {
            var modBusListeners = {}
            var registeredModels = {}
            var boundTypes = []
            var renderCalls = 0
            var baseColoursSeen = []
            var scaleArgs = []
            var registeredItems = []
            var itemModelJsons = {}
            var compositeOutlineArgs = []
            var OUTLINE_NONE = { outline: 'NONE' }

            function makeStrictClassProxy(clsName, membersObj) {
                return new Proxy(membersObj, {
                    get: function (target, prop) {
                        if (typeof prop === 'symbol' || prop === 'prototype' || prop === 'toString') return target[prop]
                        if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop]
                        throw new Error('InternalError: Java class "' + clsName + '" has no public instance field or method named "' + String(prop) + '".')
                    }
                })
            }

            function assertValidOutlineArg(arg) {
                // 还原 Rhino EnumTypeWrapper + CompositeStateBuilder.createCompositeState 重载陷阱：
                // 传入 boolean (false) 会误命中 enum 重载并抛 IllegalArgumentException: argument type mismatch
                if (typeof arg === 'boolean') {
                    throw new Error('IllegalArgumentException: argument type mismatch (boolean rejected by EnumTypeWrapper)')
                }
                assert.ok(arg === 'none' || arg === OUTLINE_NONE, 'expected OutlineProperty.NONE or "none", got: ' + arg)
                compositeOutlineArgs.push(arg)
                return { composite: true }
            }

            function ResourceLocation(ns, p) {
                this.ns = ns; this.p = p
            }
            ResourceLocation.prototype.toString = function () { return this.ns + ':' + this.p }

            function ModelResourceLocation(rl, variant) {
                this.rl = rl; this.variant = variant
            }
            ModelResourceLocation.prototype.toString = function () { return String(this.rl) + '#' + this.variant }

            // 与真实 Rhino 保持一致：实例对象 (NativeJavaObject) 访问缺失属性返回 undefined 而不抛错；静态类 (NativeJavaClass) 则抛 InternalError
            var fakeCompositeBuilder = useRemappedMojmap ? {
                setShaderState: function (s) { assert.ok(s && s.sup, 'ShaderStateShard required'); return fakeCompositeBuilder },
                setTextureState: function (t) { assert.ok(t && t.rl, 'TextureStateShard required'); return fakeCompositeBuilder },
                setTransparencyState: function (v) { assert.strictEqual(v, 'TRANSLUCENT'); return fakeCompositeBuilder },
                setCullState: function (v) { assert.strictEqual(v, 'NO_CULL'); return fakeCompositeBuilder },
                setLightmapState: function (v) { assert.strictEqual(v, 'LIGHTMAP'); return fakeCompositeBuilder },
                setOverlayState: function (v) { assert.strictEqual(v, 'OVERLAY'); return fakeCompositeBuilder },
                createCompositeState: assertValidOutlineArg
            } : {
                m_173292_: function (s) { assert.ok(s && s.sup, 'ShaderStateShard required'); return fakeCompositeBuilder },
                m_173290_: function (t) { assert.ok(t && t.rl, 'TextureStateShard required'); return fakeCompositeBuilder },
                m_110685_: function (v) { assert.strictEqual(v, 'TRANSLUCENT'); return fakeCompositeBuilder },
                m_110661_: function (v) { assert.strictEqual(v, 'NO_CULL'); return fakeCompositeBuilder },
                m_110671_: function (v) { assert.strictEqual(v, 'LIGHTMAP'); return fakeCompositeBuilder },
                m_110677_: function (v) { assert.strictEqual(v, 'OVERLAY'); return fakeCompositeBuilder },
                m_110689_: assertValidOutlineArg
            }

            var fakeCcrs = {
                brightness: 0,
                overlay: 0,
                baseColour: -1,
                reset: function () { this.baseColour = -1 },
                bind: function (rt, getter) {
                    boundTypes.push(rt.name)
                    baseColoursSeen.push(this.baseColour)
                    assert.strictEqual(getter, 'FAKE_GETTER')
                    assert.strictEqual(typeof rt.state, 'object')
                }
            }

            var fakeMatOps = []
            function FakeMatrix4(src) {
                this.src = src || null
                this.translate = function () { return this }
                this.rotate = function () { return this }
                this.scale = function (s) { scaleArgs.push(s); return this }
            }

            var fakeCrystalModel = {
                render: function (ccrs, mat) {
                    assert.strictEqual(ccrs, fakeCcrs)
                    fakeMatOps.push(mat)
                    renderCalls++
                }
            }

            var shaderCalls = { inner: 0, outer: 0 }
            var fakeBCShaders = {
                CHAOS_ENTITY_SHADER: {
                    getShaderInstance: function () { shaderCalls.inner++; return { shader: 'chaos' } },
                    hasModelMatUniform: function () { return true },
                    getModelMatUniform: function () { return { glUniformMatrix4f: function () {} } },
                    hasSimpleLightUniform: function () { return true },
                    getSimpleLightUniform: function () { return { glUniform1b: function () {} } },
                    hasDisableLightUniform: function () { return true },
                    getDisableLightUniform: function () { return { glUniform1b: function () {} } },
                    hasDisableOverlayUniform: function () { return true },
                    getDisableOverlayUniform: function () { return { glUniform1b: function () {} } }
                }
            }

            function FakeSupplier(impl) {
                this.get = impl.get
            }
            function FakeIItemRenderer(impl) {
                this.impl = impl
            }

            var sb = {
                console: { info: function () {}, warn: function (m) { throw new Error('unexpected warn: ' + m) }, error: function () {}, debug: function () {}, log: function () {} },
                Platform: { isClientEnvironment: function () { return true } },
                ForgeModEvents: {
                    onEvent: function (evName, cb) {
                        modBusListeners[evName] = cb
                    }
                },
                ForgeEvents: { onEvent: function () {} },
                StartupEvents: {
                    registry: function (kind, cb) {
                        if (kind === 'item') {
                            cb({
                                create: function (id) {
                                    registeredItems.push(id)
                                    var b = {
                                        displayName: function () { return b },
                                        texture: function () { return b },
                                        rarity: function () { return b },
                                        modelJson: function (json) { itemModelJsons[id] = json; return b }
                                    }
                                    return b
                                }
                            })
                        }
                    }
                },
                Java: {
                    loadClass: function (cls) {
                        if (cls.indexOf('net.minecraftforge.fml.') === 0) {
                            throw new Error('ClassFilter denied: ' + cls)
                        }
                        if (cls === 'net.minecraft.client.resources.model.ModelResourceLocation') return ModelResourceLocation
                        if (cls === 'net.minecraft.resources.ResourceLocation') return ResourceLocation
                        if (cls === 'codechicken.lib.render.model.OBJParser') {
                            return function () {
                                return {
                                    ignoreMtl: function () { return this },
                                    parse: function () { return { isEmpty: function () { return false }, values: function () { return ['mesh'] } } }
                                }
                            }
                        }
                        if (cls === 'codechicken.lib.render.CCModel') {
                            return {
                                combine: function () {
                                    return {
                                        backfacedCopy: function () { return this },
                                        computeNormals: function () { return fakeCrystalModel }
                                    }
                                }
                            }
                        }
                        if (cls === 'codechicken.lib.render.CCRenderState') return { instance: function () { return fakeCcrs } }
                        if (cls === 'codechicken.lib.render.item.IItemRenderer') return FakeIItemRenderer
                        if (cls === 'codechicken.lib.util.TransformUtils') return { DEFAULT_BLOCK: 'DEFAULT_BLOCK_STATE' }
                        if (cls === 'codechicken.lib.vec.Matrix4') return FakeMatrix4
                        if (cls === 'codechicken.lib.vec.Vector3') return { Y_POS: 'Y_POS' }
                        if (cls === 'com.brandon3055.brandonscore.client.shader.BCShaders') return fakeBCShaders
                        if (cls === 'com.brandon3055.brandonscore.api.TimeKeeper') return { getClientTick: function () { return 40 } }
                        if (cls === 'net.minecraft.client.Minecraft') {
                            var mcInst = useRemappedMojmap
                                ? { getFrameTime: function () { return 0.5 } }
                                : { m_91296_: function () { return 0.5 } }
                            return makeStrictClassProxy('Minecraft', useRemappedMojmap
                                ? { getInstance: function () { return mcInst } }
                                : { m_91087_: function () { return mcInst } })
                        }
                        if (cls === 'net.minecraft.client.renderer.GameRenderer') {
                            return makeStrictClassProxy('GameRenderer', useRemappedMojmap
                                ? { getRendertypeCutoutShader: function () { shaderCalls.outer++; return { shader: 'cutout' } } }
                                : { m_172646_: function () { shaderCalls.outer++; return { shader: 'cutout' } } })
                        }
                        if (cls === 'net.minecraft.client.renderer.RenderStateShard') {
                            return makeStrictClassProxy('RenderStateShard', useRemappedMojmap
                                ? { TRANSLUCENT_TRANSPARENCY: 'TRANSLUCENT', NO_CULL: 'NO_CULL', LIGHTMAP: 'LIGHTMAP', OVERLAY: 'OVERLAY' }
                                : { f_110139_: 'TRANSLUCENT', f_110110_: 'NO_CULL', f_110152_: 'LIGHTMAP', f_110154_: 'OVERLAY' })
                        }
                        if (cls === 'net.minecraft.client.renderer.RenderStateShard$ShaderStateShard') {
                            return function (sup) { this.sup = sup; this.sup.get() }
                        }
                        if (cls === 'net.minecraft.client.renderer.RenderStateShard$TextureStateShard') {
                            return function (rl) { this.rl = rl }
                        }
                        if (cls === 'net.minecraft.client.renderer.RenderType') {
                            return makeStrictClassProxy('net.minecraft.client.renderer.RenderType', useRemappedMojmap
                                ? { create: function (name, fmt, mode, sz, crumb, sort, state) { return { name: name, fmt: fmt, mode: mode, sz: sz, state: state } } }
                                : { m_173215_: function (name, fmt, mode, sz, crumb, sort, state) { return { name: name, fmt: fmt, mode: mode, sz: sz, state: state } } })
                        }
                        if (cls === 'net.minecraft.client.renderer.RenderType$CompositeState') {
                            return makeStrictClassProxy('RenderType$CompositeState', useRemappedMojmap
                                ? { builder: function () { return fakeCompositeBuilder } }
                                : { m_110628_: function () { return fakeCompositeBuilder } })
                        }
                        if (cls === 'net.minecraft.client.renderer.RenderType$OutlineProperty') {
                            return makeStrictClassProxy('RenderType$OutlineProperty', exposeOutlineEnum ? { NONE: OUTLINE_NONE } : {})
                        }
                        if (cls === 'com.mojang.blaze3d.vertex.DefaultVertexFormat') {
                            return makeStrictClassProxy('DefaultVertexFormat', useRemappedMojmap
                                ? { NEW_ENTITY: 'NEW_ENTITY' }
                                : { f_85812_: 'NEW_ENTITY' })
                        }
                        if (cls === 'com.mojang.blaze3d.vertex.VertexFormat$Mode') return { TRIANGLES: 'TRIANGLES' }
                        if (cls === 'java.util.function.Supplier') return FakeSupplier
                        return function () {}
                    }
                },
                global: {}
            }
            sb.globalThis = sb
            vm.createContext(sb)
            runScriptIn(sb, HIDDEN_PATH)

            assert.ok(registeredItems.indexOf('epiphy:chaos_crystal') >= 0, 'epiphy:chaos_crystal item must be registered')
            assert.ok(itemModelJsons['epiphy:end_gateway'] && Array.isArray(itemModelJsons['epiphy:end_gateway'].elements) && itemModelJsons['epiphy:end_gateway'].elements.length === 3, 'epiphy:end_gateway must use 3-element gateway shrine model')
            assert.strictEqual(itemModelJsons['epiphy:end_gateway'].textures.core, 'minecraft:block/sculk')
            assert.strictEqual(itemModelJsons['epiphy:end_gateway'].textures.cap, 'minecraft:block/bedrock')
            var bakingCb = modBusListeners['net.minecraftforge.client.event.ModelEvent$ModifyBakingResult']
            assert.strictEqual(typeof bakingCb, 'function', 'ModifyBakingResult must register via ForgeModEvents without denied FML classes')

            bakingCb({
                getModels: function () {
                    return {
                        put: function (mrl, model) {
                            registeredModels[String(mrl)] = model
                        }
                    }
                }
            })

            var rendererProxy = registeredModels['epiphy:chaos_crystal#inventory']
            assert.ok(rendererProxy != null && rendererProxy.impl != null, 'renderer must be bound to epiphy:chaos_crystal#inventory (not empty variant)')
            assert.strictEqual(registeredModels['epiphy:chaos_crystal#'], undefined, 'empty variant must not be used for item renderer')
            assert.strictEqual(rendererProxy.impl.getModelState(), 'DEFAULT_BLOCK_STATE')
            assert.strictEqual(rendererProxy.impl.m_7541_(), false)
            assert.strictEqual(rendererProxy.impl.useAmbientOcclusion(), false)
            assert.strictEqual(rendererProxy.impl.m_7539_(), true)
            assert.strictEqual(rendererProxy.impl.isGui3d(), true)
            assert.strictEqual(rendererProxy.impl.m_7547_(), true)
            assert.strictEqual(rendererProxy.impl.usesBlockLight(), true)
            assert.strictEqual(shaderCalls.inner, 1)
            assert.strictEqual(shaderCalls.outer, 1)

            rendererProxy.impl.renderItem({}, 'GUI', 'POSE_STACK', 'FAKE_GETTER', 15728880, 655360)
            assert.deepStrictEqual(boundTypes, ['draconicevolution:chaos_crystal_item_inner', 'draconicevolution:chaos_crystal_item_outer'])
            assert.deepStrictEqual(baseColoursSeen, [-1, -16])
            assert.strictEqual(renderCalls, 2)
            assert.strictEqual(compositeOutlineArgs.length, 2)
            if (exposeOutlineEnum) {
                assert.deepStrictEqual(compositeOutlineArgs, [OUTLINE_NONE, OUTLINE_NONE])
            } else {
                assert.deepStrictEqual(compositeOutlineArgs, ['none', 'none'])
            }
            assert.strictEqual(scaleArgs[0], 0.22)
        }

        runHiddenItemsCase(true, false)
        runHiddenItemsCase(true, true)
        runHiddenItemsCase(false, true)
    })

    test('hidden items helpers: callMcMember supports arbitrary argc and readMcMember falls back cleanly without swallowing errors or returning silent undefined', function () {
        var HIDDEN_PATH = path.join(ROOT_DIR, 'kubejs', 'startup_scripts', '通用组件', 'Epiphy的小玩意-原版_其他Mod的隐藏物品.js')
        var src = fs.readFileSync(HIDDEN_PATH, 'utf8')
        var startIdx = src.indexOf('var probeMcMember = function')
        var endIdx = src.indexOf('var buildCompositeStateNone = function')
        assert.ok(startIdx >= 0 && endIdx > startIdx, 'helper block markers must exist in hidden items script')
        var helperCode = src.slice(startIdx, endIdx) + '\nglobalThis.__mcHelpers = { probeMcMember: probeMcMember, readMcMember: readMcMember, callMcMember: callMcMember };\n'
        var sb = { globalThis: null }
        sb.globalThis = sb
        vm.createContext(sb)
        vm.runInContext(helperCode, sb)
        var h = sb.__mcHelpers

        // 1. callMcMember 覆盖 2/3/8 等任意参数个数（不再限制 0/1/7），且正确绑定 this
        var inst = {
            prefix: 'P:',
            add2: function (a, b) { return this.prefix + a + '+' + b },
            sum8: function (a, b, c, d, e, f, g, i) { return this.prefix + (a + b + c + d + e + f + g + i) },
            m_srg3_: function (x, y, z) { return this.prefix + [x, y, z].join(',') },
            f_srgField_: 42,
            nullableField: null
        }
        assert.strictEqual(h.callMcMember(inst, 'add2', 'm_add2_', 'x', 'y'), 'P:x+y')
        assert.strictEqual(h.callMcMember(inst, 'sum8', 'm_sum8_', 1, 2, 3, 4, 5, 6, 7, 8), 'P:36')
        // Mojmap 方法在实例上返回 undefined（不抛错）时正确回退 SRG 并传入 3 个参数
        assert.strictEqual(h.callMcMember(inst, 'missingMoj3', 'm_srg3_', 10, 20, 30), 'P:10,20,30')

        // 2. readMcMember 在 mojName 返回 undefined（不抛错）时回退 srgName，合法 null 不误判为缺失
        assert.strictEqual(h.readMcMember(inst, 'missingMojField', 'f_srgField_'), 42)
        assert.strictEqual(h.readMcMember(inst, 'nullableField', 'f_null_'), null)

        // 3. 双名均缺失时即使实例返回 undefined 也必须显式抛错，不能静默返回 undefined
        assert.throws(function () {
            h.readMcMember(inst, 'noSuchMoj', 'noSuchSrg')
        }, /Missing Java member noSuchMoj \/ noSuchSrg/)

        // 4. 成员存在但访问抛非“成员不存在”异常（如 IllegalAccessException）时不能被静默吞掉
        var guarded = {}
        Object.defineProperty(guarded, 'NONE', {
            enumerable: true,
            get: function () { throw new Error('IllegalAccessException: package-private enum') }
        })
        assert.throws(function () {
            h.readMcMember(guarded, 'NONE', 'NONE')
        }, /IllegalAccessException/)
    })

    test('69. rhino-check.js AST guards (Unicode let/const, Rhino SyntaxError rules, no silent javac/RHINO_JAR fallback)', function () {
        var cp = require('child_process')
        var os = require('os')
        var checkerPath = path.join(ROOT_DIR, 'scripts', 'rhino-check.js')
        var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epiphy_rhino_checker_test_'))
        try {
            function runCheckerOnSnippet(name, code, extraArgs, envPatch) {
                var fp = path.join(tmpDir, name)
                fs.writeFileSync(fp, code, 'utf8')
                var env = Object.assign({}, process.env)
                delete env.RHINO_JAR
                delete env.MC_MODS_DIR
                delete env.RHINO_JAVAC_BIN
                delete env.RHINO_JAVA_BIN
                if (envPatch) {
                    for (var k in envPatch) env[k] = envPatch[k]
                }
                return cp.spawnSync(process.execPath, [checkerPath].concat(extraArgs || ['--force-local']).concat([fp]), {
                    encoding: 'utf8',
                    env: env
                })
            }

            // 1. Unicode/Chinese identifier const/let MUST fail
            var rCnConst = runCheckerOnSnippet('cn_const.js', 'const 甲 = 1;\n')
            assert.notStrictEqual(rCnConst.status, 0, 'const 甲 = 1 must be rejected by AST semantic-drift guard')

            var rCnLet = runCheckerOnSnippet('cn_let.js', 'for (let 索引 = 0; 索引 < 3; 索引++) {}\n')
            assert.notStrictEqual(rCnLet.status, 0, 'for (let 索引 ...) must be rejected by AST semantic-drift guard')

            // 2. Documented kube-mods/rhino SyntaxErrors MUST fail in local AST mode
            var badSnippets = [
                ['shorthand.js',     'var x = 1; var o = { x };\n'],
                ['computed.js',      'var k = "a"; var o = { [k]: 1 };\n'],
                ['default_param.js', 'function f(a = 1) { return a; }\n'],
                ['destr_def.js',     'var { a = 1 } = {};\n'],
                ['spread.js',        'var a = [1, 2]; var b = [...a];\n'],
                ['new_target.js',    'function F() { return new.target; }\n'],
                ['nullish.js',       'var v = null ?? 9;\n'],
                ['regex_u.js',       'var r = /abc/u;\n']
            ]
            for (var bi = 0; bi < badSnippets.length; bi++) {
                var rBad = runCheckerOnSnippet(badSnippets[bi][0], badSnippets[bi][1])
                assert.notStrictEqual(rBad.status, 0, badSnippets[bi][0] + ' must be rejected by local-acorn-ast')
            }

            // 3. Rhino-supported ES5 + basic destructuring + method shorthand MUST pass
            var rGood = runCheckerOnSnippet('good.js', 'var obj = { a: 1, b: 2, m(x) { return x + 1; } }; var { a, b } = obj; var arrow = (v) => `${v}`;\n')
            assert.strictEqual(rGood.status, 0, 'Rhino-compatible code must pass local-acorn-ast: ' + (rGood.stderr || rGood.stdout))

            // 4. Explicit nonexistent RHINO_JAR MUST fail hard (no silent fallback)
            var rMissingEnv = runCheckerOnSnippet('ok_env.js', 'var ok = 1;\n', [], {
                RHINO_JAR: path.join(tmpDir, 'does_not_exist_rhino.jar')
            })
            assert.notStrictEqual(rMissingEnv.status, 0, 'explicit missing RHINO_JAR must fail hard instead of falling back')

            // 5. Existing JAR + failing javac MUST fail hard (no silent fallback to green, deterministic even without JDK)
            var fakeJar = path.join(tmpDir, 'rhino-forge-fake.jar')
            fs.writeFileSync(fakeJar, 'not-a-valid-jar', 'utf8')
            var rBrokenJavac = runCheckerOnSnippet('ok_broken_javac.js', 'var ok = 1;\n', [], {
                RHINO_JAR:       fakeJar,
                RHINO_CACHE_DIR: path.join(tmpDir, 'fresh_cache'),
                RHINO_JAVAC_BIN: process.execPath
            })
            assert.notStrictEqual(rBrokenJavac.status, 0, 'existing JAR + failing javac must NEVER silently degrade to exit 0')
            assert.ok((rBrokenJavac.stderr || '').indexOf('禁止静默降级') >= 0, 'stderr must explicitly report fail-hard on toolchain error')
        } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (eRm) { }
        }
    })
}
