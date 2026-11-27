// 许可证声明 (License): 本文件适用 RAL-1.6 (Reciprocal Attribution License 1.6 / 相互开源署名许可证 1.6)
package dev.epiphy

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.Label
import org.objectweb.asm.MethodVisitor
import org.objectweb.asm.Opcodes
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/**
 * M0 字节码级安全门禁测试：
 * 1. 验证 `EpiphyMod.class` 绝不在字节码中直接引用任何客户端专属类（防止 Dedicated Server 启动触发 NoClassDefFoundError）；
 * 2. 验证 `PoseStackExtKt.withPose` 编译产物具备真正的 `try / finally` 异常表保护。
 */
class BytecodeSafetyGuardTest {

    private fun findMainClassFile(relPath: String): Path {
        val rawDirs = System.getProperty("epiphy.mainClassesDirs").orEmpty()
        val roots = rawDirs.split(File.pathSeparator).filter { it.isNotBlank() }.map { Path.of(it) }
        return roots.map { it.resolve(relPath) }.firstOrNull { Files.isRegularFile(it) }
            ?: error("Cannot find compiled class '$relPath' in roots: $roots")
    }

    private fun assertZeroClientReferences(classRelPath: String) {
        val classBytes = Files.readAllBytes(findMainClassFile(classRelPath))
        val referencedTypes = LinkedHashSet<String>()

        ClassReader(classBytes).accept(object : ClassVisitor(Opcodes.ASM9) {
            override fun visitMethod(
                access: Int,
                name: String?,
                descriptor: String?,
                signature: String?,
                exceptions: Array<out String>?
            ): MethodVisitor {
                descriptor?.let { referencedTypes.add(it) }
                return object : MethodVisitor(Opcodes.ASM9) {
                    override fun visitMethodInsn(
                        opcode: Int,
                        owner: String?,
                        name: String?,
                        descriptor: String?,
                        isInterface: Boolean
                    ) {
                        owner?.let { referencedTypes.add(it) }
                        descriptor?.let { referencedTypes.add(it) }
                    }

                    override fun visitFieldInsn(opcode: Int, owner: String?, name: String?, descriptor: String?) {
                        owner?.let { referencedTypes.add(it) }
                        descriptor?.let { referencedTypes.add(it) }
                    }

                    override fun visitTypeInsn(opcode: Int, type: String?) {
                        type?.let { referencedTypes.add(it) }
                    }
                }
            }
        }, 0)

        val forbiddenClientPrefixes = listOf(
            "net/minecraft/client/",
            "com/mojang/blaze3d/",
            "net/minecraftforge/client/event/"
        )

        for (ref in referencedTypes) {
            for (prefix in forbiddenClientPrefixes) {
                assertFalse(
                    ref.contains(prefix),
                    "Dedicated Server safety violation! $classRelPath directly references client-only type '$prefix' via '$ref'"
                )
            }
        }
    }

    @Test
    fun `EpiphyMod and EpiphyConfig classes contain zero direct references to client-only classes for Dedicated Server safety`() {
        assertZeroClientReferences("dev/epiphy/EpiphyMod.class")
        assertZeroClientReferences("dev/epiphy/core/config/EpiphyConfig.class")
    }

    @Test
    fun `PoseStack withPose inline helper emits try-finally exception handler table`() {
        val extBytes = Files.readAllBytes(findMainClassFile("dev/epiphy/client/util/PoseStackExtKt.class"))
        var tryCatchBlocksCount = 0

        ClassReader(extBytes).accept(object : ClassVisitor(Opcodes.ASM9) {
            override fun visitMethod(
                access: Int,
                name: String?,
                descriptor: String?,
                signature: String?,
                exceptions: Array<out String>?
            ): MethodVisitor? {
                if (name != "withPose") return null
                return object : MethodVisitor(Opcodes.ASM9) {
                    override fun visitTryCatchBlock(start: Label?, end: Label?, handler: Label?, type: String?) {
                        if (type == null) {
                            // type == null 在 JVM 字节码中代表 finally (catch-any) 异常处理器
                            tryCatchBlocksCount++
                        }
                    }
                }
            }
        }, 0)

        assertTrue(
            tryCatchBlocksCount >= 1,
            "PoseStack.withPose must emit a real JVM finally exception table entry (got $tryCatchBlocksCount)"
        )
    }

    @Test
    fun `EpiphyClientBootstrap and EpiphyKubeJSPlugin avoid runtime java lang reflect calls`() {
        val compatDirs = File("build/classes/kotlin/compat").takeIf { it.isDirectory }
        val targets = mutableListOf(findMainClassFile("dev/epiphy/client/EpiphyClientBootstrap.class"))
        if (compatDirs != null) {
            val kjsPluginClass = compatDirs.toPath().resolve("dev/epiphy/compat/kubejs/EpiphyKubeJSPlugin.class")
            if (Files.isRegularFile(kjsPluginClass)) {
                targets.add(kjsPluginClass)
            }
        }

        for (clsPath in targets) {
            val reflectionCalls = ArrayList<String>()
            ClassReader(Files.readAllBytes(clsPath)).accept(object : ClassVisitor(Opcodes.ASM9) {
                override fun visitMethod(
                    access: Int,
                    name: String?,
                    descriptor: String?,
                    signature: String?,
                    exceptions: Array<out String>?
                ): MethodVisitor {
                    return object : MethodVisitor(Opcodes.ASM9) {
                        override fun visitMethodInsn(
                            opcode: Int,
                            owner: String?,
                            mName: String?,
                            mDesc: String?,
                            isInterface: Boolean
                        ) {
                            if (owner == "java/lang/Class" && (mName == "forName" || mName == "getField" || mName == "getDeclaredField" || mName == "getMethod" || mName == "getDeclaredMethod")) {
                                reflectionCalls.add("$owner.$mName$mDesc")
                            }
                            if (owner != null && owner.startsWith("java/lang/reflect/")) {
                                reflectionCalls.add("$owner.$mName$mDesc")
                            }
                        }
                    }
                }
            }, 0)

            assertTrue(
                reflectionCalls.isEmpty(),
                "Unexpected reflection calls found in ${clsPath.fileName}: $reflectionCalls"
            )
        }
    }
}
