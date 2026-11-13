// priority: 1000
// ============================================================================
//  通用创造模式物品栏模块 —— [Epiphy的小玩意] (epiphy:stuff)
//  许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
//  放置位置：kubejs/startup_scripts/通用组件/创造模式栏-epiphy.js
//
//  职责说明：
//    1. 仅负责建立并维护创造模式物品栏 `epiphy:stuff`（显示名：“Epiphy的小玩意”），不包含任何具体业务物品清单；
//    2. 暴露 `global.EpiphyCreativeTab` 接口（`register` / `add` / `setIcon`），供其他模块向本创造栏注册物品或设置图标；
//    3. 采用版本号脏标记缓存（Memoization），避免每次打开创造栏时重复调用 `Item.of()` 与去重计算；
//    4. 自动从 KubeJS 默认的 `kubejs:tab` 中移除已归入 `epiphy:stuff` 的自定义物品，防止新注册物品在 GUI 中同时出现 KubeJS 与 Epiphy的小玩意 多个创造栏标签。
// ============================================================================

;(function () {
    var TAB_ID          = 'epiphy:stuff'
    var TAB_DISPLAY     = 'Epiphy的小玩意'
    var DEFAULT_ICON_ID = 'minecraft:command_block'

    var registeredEntries = []
    var customIconId      = ''
    var entriesVersion    = 0
    var cachedVersion     = -1
    var cachedStacks      = null

    function registerItems(itemOrArray) {
        if (itemOrArray == null) return
        var list = Array.isArray(itemOrArray) ? itemOrArray : [itemOrArray]
        var added = false
        for (var i = 0; i < list.length; i++) {
            if (list[i] != null && list[i] !== '') {
                registeredEntries.push(list[i])
                added = true
            }
        }
        if (added) {
            entriesVersion++
            cachedStacks = null
        }
    }

    function setTabIcon(itemId) {
        if (itemId != null && String(itemId).trim().length > 0) {
            customIconId = String(itemId).trim()
        }
    }

    function absorbPendingQueue() {
        if (typeof global !== 'undefined' && global != null && Array.isArray(global.EpiphyCreativeTabQueue) && global.EpiphyCreativeTabQueue.length > 0) {
            registerItems(global.EpiphyCreativeTabQueue)
            global.EpiphyCreativeTabQueue.length = 0
        }
    }

    absorbPendingQueue()

    try {
        global.EpiphyCreativeTab = {
            TAB_ID:   TAB_ID,
            add:      registerItems,
            register: registerItems,
            setIcon:  setTabIcon
        }
    } catch (eGlob) { }

    function resolveValidStack(entry) {
        if (entry == null) return null
        try {
            var stack = (typeof entry === 'string') ? Item.of(entry) : entry
            if (stack == null) return null
            if (typeof stack.isEmpty === 'function' && stack.isEmpty()) return null
            if (stack.empty === true) return null
            var idStr = (stack.id != null) ? String(stack.id) : ''
            if (idStr === 'minecraft:air' || idStr === 'air') return null
            return stack
        } catch (e) {
            return null
        }
    }

    // 带版本号缓存的创造栏物品列表构建：仅在首次打开或有新条目注册时执行一次 Item.of 与去重，后续开栏直接 O(1) 返回缓存数组
    function buildTabContentList() {
        absorbPendingQueue()
        if (cachedStacks != null && cachedVersion === entriesVersion && cachedStacks.length > 0) {
            return cachedStacks
        }

        var seenKey = {}
        var result  = []
        for (var i = 0; i < registeredEntries.length; i++) {
            var raw   = registeredEntries[i]
            var stack = resolveValidStack(raw)
            if (stack == null) continue
            var dedupKey = String(stack.id || raw) + '|' + String(stack.nbtString || '')
            if (seenKey[dedupKey]) continue
            seenKey[dedupKey] = true
            result.push(stack)
        }

        if (result.length > 0) {
            cachedStacks  = result
            cachedVersion = entriesVersion
        }
        return result
    }

    StartupEvents.registry('creative_mode_tab', function (event) {
        event.create(TAB_ID)
            .displayName(TAB_DISPLAY)
            // 确保 content 为空数组并显式处理内容追加，规避 KubeJS 的占位提醒
            .content(function (items) {
                // 不在这里直接填充，改由 modifyCreativeTab 事件处理
            })
    })

    StartupEvents.modifyCreativeTab(TAB_ID, function (event) {
        try {
            absorbPendingQueue()
            var iconStack = (customIconId ? resolveValidStack(customIconId) : null)
                || (registeredEntries.length > 0 ? resolveValidStack(registeredEntries[0]) : null)
                || resolveValidStack(DEFAULT_ICON_ID)
            if (iconStack != null) {
                event.setIcon(iconStack)
            }

            // 以 'parent_tab_only' (CreativeModeTab.TabVisibility.PARENT_TAB_ONLY) 可见性将物品加入创造栏：
            //   原版在物品 Tooltip 中显示所属创造栏名称（“Epiphy的小玩意”）的机制是检查 tab.contains(stack)（即 searchTabDisplayItems）。
            //   使用 'parent_tab_only' 仅将物品放入当前创造栏自身（displayItems），不塞入 searchTabDisplayItems，
            //   从而在底层原生机制上让物品 Tooltip 不再出现“Epiphy的小玩意”这一行，只保留底部的蓝色命名空间（如 Epiphy / Minecraft）！
            var stacks = buildTabContentList()
            if (stacks.length > 0) {
                event.add(stacks, 'parent_tab_only')
            }
        } catch (e) {
            console.warn('[EpiphyCreativeTab] 构建创造栏内容或图标失败：' + e)
        }
    })

    // KubeJS 会默认把所有通过 StartupEvents.registry('item'/'block') 新建的物品塞进 'kubejs:tab'，
    // 导致该物品在背包/JEI/REI 的 Tooltip 中同时显示 [Epiphy] + [KubeJS] + [Epiphy的小玩意] 三个标签。
    // 此处将所有已注册到 epiphy:stuff 的自定义物品从 kubejs:tab 中移除。
    StartupEvents.modifyCreativeTab('kubejs:tab', function (event) {
        try {
            absorbPendingQueue()
            for (var i = 0; i < registeredEntries.length; i++) {
                var raw = registeredEntries[i]
                var idStr = (typeof raw === 'string') ? raw : (raw != null && raw.id != null ? String(raw.id) : '')
                if (idStr.indexOf('epiphy:') === 0 || idStr.indexOf('kubejs:') === 0) {
                    event.remove(idStr)
                }
            }
        } catch (eRem) { }
    })
})()
