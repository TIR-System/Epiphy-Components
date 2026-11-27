// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy.client.config

import dev.epiphy.client.debug.EpiphyRenderPerfReporter
import dev.epiphy.core.config.EpiphyConfig
import dev.epiphy.core.config.EpiphyConfig.TextOutlineQuality
import net.minecraft.ChatFormatting
import net.minecraft.client.gui.GuiGraphics
import net.minecraft.client.gui.components.AbstractSliderButton
import net.minecraft.client.gui.components.AbstractWidget
import net.minecraft.client.gui.components.Button
import net.minecraft.client.gui.screens.Screen
import net.minecraft.network.chat.CommonComponents
import net.minecraft.network.chat.Component
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Epiphy Core 游戏内可视化配置中心界面（从 Forge 模组列表点击「配置 / Config」直接进入）。
 *
 * - 支持分类浏览、鼠标滚轮平滑滚动、悬停详细说明提示、「恢复默认」与「保存并立即热生效」；
 * - 所有配置均保存于 `<gameDir>/config/epiphy-*.toml`，严格独立于世界存档目录。
 */
class EpiphyConfigScreen(private val parent: Screen?) : Screen(Component.translatable("epiphy.config.title")) {

    private sealed interface ListRow {
        val height: Int
    }

    private class CategoryRow(val title: Component) : ListRow {
        override val height: Int = 24
    }

    private class OptionRow(
        val label: Component,
        val tooltip: Component,
        val widget: AbstractWidget
    ) : ListRow {
        override val height: Int = 24
    }

    // 界面编辑期草稿值（点击「保存」时统一写回 ForgeConfigSpec 并即时触发客户端引擎热同步）
    private var draftSurface2D: Boolean = EpiphyConfig.surface2DEnabled
    private var draftNativeTextBatcher: Boolean = EpiphyConfig.nativeTextBatcherEnabled
    private var draftOutlineQuality: TextOutlineQuality =
        runCatching { EpiphyConfig.CLIENT.textOutlineQuality.get() }.getOrDefault(TextOutlineQuality.HIGH)
    private var draftFboCache: Boolean = EpiphyConfig.fboCacheEnabled
    private var draftGuiTextureRemap: Boolean = EpiphyConfig.guiTextureRemapEnabled
    private var draftFrameBudgetMs: Double = EpiphyConfig.surface2DFrameBudgetMs

    private var draftItem3D: Boolean = EpiphyConfig.item3DEnabled
    private var draftItem3DOverlays: Boolean = EpiphyConfig.item3DOverlaysEnabled
    private var draftItem3DGeometry: Boolean = EpiphyConfig.item3DGeometryEnabled
    private var draftItem3DGuiScale: Double = EpiphyConfig.item3DGuiScale.toDouble()
    private var draftWorld3D: Boolean = EpiphyConfig.world3DEnabled

    private var draftSpatialAudio: Boolean = EpiphyConfig.spatialAudioEnabled
    private var draftMusicDucking: Boolean = EpiphyConfig.vanillaMusicDuckingEnabled
    private var draftDebugPerf: Boolean = EpiphyConfig.debugPerfSamplingEnabled
    private var draftAsyncLog: Boolean = EpiphyConfig.asyncFileLogging
    private var draftDeprecationWarn: Boolean = EpiphyConfig.deprecationWarnings

    private val rows = ArrayList<ListRow>(20)
    private var scrollOffset: Double = 0.0
    private var contentHeight: Int = 0
    private var activeDraggingWidget: AbstractWidget? = null

    private val headerHeight = 38
    private val footerHeight = 34
    private val controlWidth = 132

    override fun init() {
        super.init()
        rebuildRows()

        val btnY = this.height - 27
        val btnW = 104
        val gap = 8
        val totalW = btnW * 3 + gap * 2
        val startX = (this.width - totalW) / 2

        addRenderableWidget(
            Button.builder(Component.translatable("epiphy.config.button.reset")) {
                resetDraftsToDefault()
                rebuildRows()
            }.bounds(startX, btnY, btnW, 20).build()
        )

        addRenderableWidget(
            Button.builder(Component.translatable("epiphy.config.button.cancel")) {
                onClose()
            }.bounds(startX + btnW + gap, btnY, btnW, 20).build()
        )

        addRenderableWidget(
            Button.builder(
                Component.translatable("epiphy.config.button.save").withStyle(ChatFormatting.AQUA)
            ) {
                commitDraftsAndSave()
                onClose()
            }.bounds(startX + (btnW + gap) * 2, btnY, btnW, 20).build()
        )
    }

    private fun rebuildRows() {
        rows.clear()

        // 分类一：2D 平面合成与富文本引擎
        rows.add(CategoryRow(Component.translatable("epiphy.config.category.surface2d")))
        rows.add(boolOption("epiphy.config.client.enableSurface2D", { draftSurface2D }) { draftSurface2D = it })
        rows.add(boolOption("epiphy.config.client.enableNativeTextBatcher", { draftNativeTextBatcher }) { draftNativeTextBatcher = it })
        rows.add(
            OptionRow(
                Component.translatable("epiphy.config.client.textOutlineQuality"),
                Component.translatable("epiphy.config.client.textOutlineQuality.tooltip"),
                Button.builder(formatOutlineQualityLabel(draftOutlineQuality)) { btn ->
                    draftOutlineQuality = draftOutlineQuality.next()
                    btn.message = formatOutlineQualityLabel(draftOutlineQuality)
                }.bounds(0, 0, controlWidth, 20).build()
            )
        )
        rows.add(boolOption("epiphy.config.client.enableFboCache", { draftFboCache }) { draftFboCache = it })
        rows.add(boolOption("epiphy.config.client.enableGuiTextureRemap", { draftGuiTextureRemap }) { draftGuiTextureRemap = it })
        rows.add(
            rangeSliderOption(
                key = "epiphy.config.client.surface2DFrameBudgetMs",
                minVal = 0.5,
                maxVal = 16.0,
                step = 0.25,
                initial = draftFrameBudgetMs,
                formatter = { v -> String.format(Locale.ROOT, "%.2f ms", v) },
                onChange = { draftFrameBudgetMs = it }
            )
        )

        // 分类二：3D 物品与空间特效管线
        rows.add(CategoryRow(Component.translatable("epiphy.config.category.fx3d")))
        rows.add(boolOption("epiphy.config.client.enableItem3D", { draftItem3D }) { draftItem3D = it })
        rows.add(boolOption("epiphy.config.client.enableItem3DOverlays", { draftItem3DOverlays }) { draftItem3DOverlays = it })
        rows.add(boolOption("epiphy.config.client.enableItem3DGeometry", { draftItem3DGeometry }) { draftItem3DGeometry = it })
        rows.add(
            rangeSliderOption(
                key = "epiphy.config.client.item3DGuiScale",
                minVal = 0.25,
                maxVal = 2.0,
                step = 0.05,
                initial = draftItem3DGuiScale,
                formatter = { v -> String.format(Locale.ROOT, "%.2fx", v) },
                onChange = { draftItem3DGuiScale = it }
            )
        )
        rows.add(boolOption("epiphy.config.client.enableWorld3D", { draftWorld3D }) { draftWorld3D = it })

        // 分类三：空间音频、日志与遥测
        rows.add(CategoryRow(Component.translatable("epiphy.config.category.audio_debug")))
        rows.add(boolOption("epiphy.config.client.enableSpatialAudio", { draftSpatialAudio }) { draftSpatialAudio = it })
        rows.add(boolOption("epiphy.config.client.enableVanillaMusicDucking", { draftMusicDucking }) { draftMusicDucking = it })
        rows.add(boolOption("epiphy.config.client.debugPerfSampling", { draftDebugPerf }) { draftDebugPerf = it })
        rows.add(
            OptionRow(
                Component.translatable("epiphy.config.client.exportPerfReport"),
                Component.translatable("epiphy.config.client.exportPerfReport.tooltip"),
                Button.builder(Component.translatable("epiphy.config.button.exportReport").withStyle(ChatFormatting.GOLD)) { btn ->
                    val ok = runCatching { EpiphyRenderPerfReporter.exportMarkdownReport() }.isSuccess
                    btn.message = Component.translatable(
                        if (ok) "epiphy.config.button.exportedOk" else "epiphy.config.button.exportFailed"
                    ).withStyle(if (ok) ChatFormatting.GREEN else ChatFormatting.RED)
                }.bounds(0, 0, controlWidth, 20).build()
            )
        )
        rows.add(boolOption("epiphy.config.common.enableAsyncFileLogging", { draftAsyncLog }) { draftAsyncLog = it })
        rows.add(boolOption("epiphy.config.common.logDeprecationWarnings", { draftDeprecationWarn }) { draftDeprecationWarn = it })

        contentHeight = rows.sumOf { it.height } + 12
        clampScroll()
    }

    private fun boolOption(key: String, getter: () -> Boolean, setter: (Boolean) -> Unit): OptionRow {
        val btn = Button.builder(formatBoolLabel(getter())) { b ->
            val next = !getter()
            setter(next)
            b.message = formatBoolLabel(next)
        }.bounds(0, 0, controlWidth, 20).build()
        return OptionRow(
            Component.translatable(key),
            Component.translatable("$key.tooltip"),
            btn
        )
    }

    private fun rangeSliderOption(
        key: String,
        minVal: Double,
        maxVal: Double,
        step: Double,
        initial: Double,
        formatter: (Double) -> String,
        onChange: (Double) -> Unit
    ): OptionRow {
        val span = (maxVal - minVal).coerceAtLeast(1e-6)
        val norm0 = ((initial - minVal) / span).coerceIn(0.0, 1.0)
        val slider = object : AbstractSliderButton(0, 0, controlWidth, 20, CommonComponents.EMPTY, norm0) {
            private fun currentQuantized(): Double {
                val raw = minVal + this.value * span
                val snapped = (raw / step).roundToInt() * step
                return snapped.coerceIn(minVal, maxVal)
            }

            init {
                updateMessage()
            }

            override fun updateMessage() {
                this.message = Component.literal(formatter(currentQuantized())).withStyle(ChatFormatting.YELLOW)
            }

            override fun applyValue() {
                onChange(currentQuantized())
            }
        }
        return OptionRow(
            Component.translatable(key),
            Component.translatable("$key.tooltip"),
            slider
        )
    }

    private fun formatBoolLabel(v: Boolean): Component =
        if (v) {
            Component.translatable("epiphy.config.value.on").withStyle(ChatFormatting.GREEN)
        } else {
            Component.translatable("epiphy.config.value.off").withStyle(ChatFormatting.GRAY)
        }

    private fun formatOutlineQualityLabel(q: TextOutlineQuality): Component {
        val color = when (q) {
            TextOutlineQuality.HIGH -> ChatFormatting.AQUA
            TextOutlineQuality.BALANCED -> ChatFormatting.GREEN
            TextOutlineQuality.PERFORMANCE -> ChatFormatting.YELLOW
            TextOutlineQuality.OFF -> ChatFormatting.GRAY
        }
        return Component.translatable(q.translationKey).withStyle(color)
    }

    private fun resetDraftsToDefault() {
        draftSurface2D = true
        draftNativeTextBatcher = true
        draftOutlineQuality = TextOutlineQuality.HIGH
        draftFboCache = true
        draftGuiTextureRemap = true
        draftFrameBudgetMs = 4.0

        draftItem3D = true
        draftItem3DOverlays = true
        draftItem3DGeometry = true
        draftItem3DGuiScale = 1.0
        draftWorld3D = true

        draftSpatialAudio = true
        draftMusicDucking = true
        draftDebugPerf = false
        draftAsyncLog = true
        draftDeprecationWarn = false
    }

    private fun commitDraftsAndSave() {
        runCatching {
            if (EpiphyConfig.CLIENT_SPEC.isLoaded) {
                EpiphyConfig.CLIENT.enableSurface2D.set(draftSurface2D)
                EpiphyConfig.CLIENT.enableNativeTextBatcher.set(draftNativeTextBatcher)
                EpiphyConfig.CLIENT.textOutlineQuality.set(draftOutlineQuality)
                EpiphyConfig.CLIENT.enableFboCache.set(draftFboCache)
                EpiphyConfig.CLIENT.enableGuiTextureRemap.set(draftGuiTextureRemap)
                EpiphyConfig.CLIENT.surface2DFrameBudgetMs.set(draftFrameBudgetMs.coerceIn(0.5, 16.0))

                EpiphyConfig.CLIENT.enableItem3D.set(draftItem3D)
                EpiphyConfig.CLIENT.enableItem3DOverlays.set(draftItem3DOverlays)
                EpiphyConfig.CLIENT.enableItem3DGeometry.set(draftItem3DGeometry)
                EpiphyConfig.CLIENT.item3DGuiScale.set(draftItem3DGuiScale.coerceIn(0.25, 2.0))
                EpiphyConfig.CLIENT.enableWorld3D.set(draftWorld3D)

                EpiphyConfig.CLIENT.enableSpatialAudio.set(draftSpatialAudio)
                EpiphyConfig.CLIENT.enableVanillaMusicDucking.set(draftMusicDucking)
                EpiphyConfig.CLIENT.debugPerfSampling.set(draftDebugPerf)
            }
            if (EpiphyConfig.COMMON_SPEC.isLoaded) {
                EpiphyConfig.COMMON.enableAsyncFileLogging.set(draftAsyncLog)
                EpiphyConfig.COMMON.logDeprecationWarnings.set(draftDeprecationWarn)
            }
        }
        // 即时更新内存快照（即使极端环境下 spec 尚未挂载，镜像字段亦立即对本会话生效）
        EpiphyConfig.surface2DEnabled = draftSurface2D
        EpiphyConfig.nativeTextBatcherEnabled = draftNativeTextBatcher
        EpiphyConfig.outlineQualityLevel = draftOutlineQuality.levelCode
        EpiphyConfig.fboCacheEnabled = draftFboCache
        EpiphyConfig.guiTextureRemapEnabled = draftGuiTextureRemap
        EpiphyConfig.surface2DFrameBudgetMs = draftFrameBudgetMs.coerceIn(0.5, 16.0)

        EpiphyConfig.item3DEnabled = draftItem3D
        EpiphyConfig.item3DOverlaysEnabled = draftItem3DOverlays
        EpiphyConfig.item3DGeometryEnabled = draftItem3DGeometry
        EpiphyConfig.item3DGuiScale = draftItem3DGuiScale.toFloat().coerceIn(0.25f, 2.0f)
        EpiphyConfig.world3DEnabled = draftWorld3D

        EpiphyConfig.spatialAudioEnabled = draftSpatialAudio
        EpiphyConfig.vanillaMusicDuckingEnabled = draftMusicDucking
        EpiphyConfig.debugPerfSamplingEnabled = draftDebugPerf
        EpiphyConfig.asyncFileLogging = draftAsyncLog
        EpiphyConfig.deprecationWarnings = draftDeprecationWarn

        EpiphyConfig.saveClientAndSync()
    }

    private fun viewportTop(): Int = headerHeight
    private fun viewportBottom(): Int = this.height - footerHeight
    private fun maxScroll(): Double = max(0, contentHeight - (viewportBottom() - viewportTop())).toDouble()

    private fun clampScroll() {
        scrollOffset = scrollOffset.coerceIn(0.0, maxScroll())
    }

    override fun render(guiGraphics: GuiGraphics, mouseX: Int, mouseY: Int, partialTick: Float) {
        renderBackground(guiGraphics)

        val vTop = viewportTop()
        val vBottom = viewportBottom()
        val rowWidth = minOf(360, this.width - 28)
        val rowLeft = (this.width - rowWidth) / 2
        val inViewport = mouseY in vTop until vBottom

        // 列表深色内衬背景
        guiGraphics.fill(0, vTop, this.width, vBottom, 0x68080C12)

        var hoveredTooltip: Component? = null
        guiGraphics.enableScissor(0, vTop, this.width, vBottom)
        try {
            var curY = vTop + 6 - scrollOffset.roundToInt()
            var optIndex = 0
            for (row in rows) {
                val rBottom = curY + row.height
                if (rBottom >= vTop && curY <= vBottom) {
                    when (row) {
                        is CategoryRow -> {
                            guiGraphics.fill(rowLeft, curY + 4, rowLeft + rowWidth, curY + row.height - 2, 0x70162436)
                            guiGraphics.fill(rowLeft, curY + 4, rowLeft + 3, curY + row.height - 2, 0xFF4FD2FF.toInt())
                            guiGraphics.drawString(
                                this.font,
                                row.title,
                                rowLeft + 8,
                                curY + 8,
                                0x7CEBFF,
                                true
                            )
                        }
                        is OptionRow -> {
                            val isHoverRow = inViewport && mouseX in rowLeft..(rowLeft + rowWidth) && mouseY in curY until rBottom
                            val bgCol = if (isHoverRow) {
                                0x552A3B52
                            } else if ((optIndex and 1) == 0) {
                                0x2E121822
                            } else {
                                0x18121822
                            }
                            guiGraphics.fill(rowLeft, curY + 1, rowLeft + rowWidth, rBottom - 1, bgCol)
                            guiGraphics.drawString(
                                this.font,
                                row.label,
                                rowLeft + 8,
                                curY + 8,
                                if (isHoverRow) 0xFFFFFF else 0xDCE4EE,
                                false
                            )
                            row.widget.x = rowLeft + rowWidth - controlWidth - 4
                            row.widget.y = curY + 2
                            row.widget.render(guiGraphics, if (inViewport) mouseX else -1000, if (inViewport) mouseY else -1000, partialTick)
                            if (isHoverRow) {
                                hoveredTooltip = row.tooltip
                            }
                            optIndex++
                        }
                    }
                } else if (row is OptionRow) {
                    row.widget.y = -1000
                    optIndex++
                }
                curY += row.height
            }
        } finally {
            guiGraphics.disableScissor()
        }

        // 右侧轻量滚动条指示器
        val maxScr = maxScroll()
        if (maxScr > 0.5) {
            val viewH = (vBottom - vTop).coerceAtLeast(16)
            val barH = ((viewH * viewH).toDouble() / contentHeight.coerceAtLeast(1)).roundToInt().coerceIn(20, viewH - 4)
            val barY = vTop + ((scrollOffset / maxScr) * (viewH - barH)).roundToInt()
            val barX = rowLeft + rowWidth + 5
            guiGraphics.fill(barX, vTop + 2, barX + 3, vBottom - 2, 0x44000000)
            guiGraphics.fill(barX, barY, barX + 3, barY + barH, 0xAA66CCEE.toInt())
        }

        // 顶栏与底栏装饰分割线
        guiGraphics.fill(0, 0, this.width, vTop, 0xB80A0E16.toInt())
        guiGraphics.fill(0, vTop - 1, this.width, vTop, 0x884FD2FF.toInt())
        guiGraphics.fill(0, vBottom, this.width, this.height, 0xB80A0E16.toInt())
        guiGraphics.fill(0, vBottom, this.width, vBottom + 1, 0x664FD2FF)

        guiGraphics.drawCenteredString(this.font, this.title, this.width / 2, 9, 0xFFFFFF)
        guiGraphics.drawCenteredString(
            this.font,
            Component.translatable("epiphy.config.subtitle"),
            this.width / 2,
            22,
            0x9AAABB
        )

        super.render(guiGraphics, mouseX, mouseY, partialTick)

        if (hoveredTooltip != null) {
            guiGraphics.renderTooltip(this.font, this.font.split(hoveredTooltip, 230), mouseX, mouseY)
        }
    }

    override fun mouseScrolled(mouseX: Double, mouseY: Double, delta: Double): Boolean {
        if (mouseY >= viewportTop() && mouseY < viewportBottom()) {
            scrollOffset -= delta * 18.0
            clampScroll()
            return true
        }
        return super.mouseScrolled(mouseX, mouseY, delta)
    }

    override fun mouseClicked(mouseX: Double, mouseY: Double, button: Int): Boolean {
        if (mouseY >= viewportTop() && mouseY < viewportBottom()) {
            for (row in rows) {
                if (row is OptionRow && row.widget.mouseClicked(mouseX, mouseY, button)) {
                    activeDraggingWidget = row.widget
                    return true
                }
            }
        }
        return super.mouseClicked(mouseX, mouseY, button)
    }

    override fun mouseDragged(mouseX: Double, mouseY: Double, button: Int, dragX: Double, dragY: Double): Boolean {
        val dragging = activeDraggingWidget
        if (dragging != null && dragging.mouseDragged(mouseX, mouseY, button, dragX, dragY)) {
            return true
        }
        return super.mouseDragged(mouseX, mouseY, button, dragX, dragY)
    }

    override fun mouseReleased(mouseX: Double, mouseY: Double, button: Int): Boolean {
        val dragging = activeDraggingWidget
        activeDraggingWidget = null
        if (dragging != null && dragging.mouseReleased(mouseX, mouseY, button)) {
            return true
        }
        return super.mouseReleased(mouseX, mouseY, button)
    }

    override fun onClose() {
        this.minecraft?.setScreen(parent)
    }
}
