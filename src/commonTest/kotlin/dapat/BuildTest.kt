package dapat

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BuildTest {

    @Test
    fun testEmptyBuild() = runTest {
        val build = Build()
        val result = build.run()

        assertTrue(result.success)
        assertTrue(result.executed.isEmpty())
        assertTrue(result.skipped.isEmpty())
    }

    @Test
    fun testSingleTask() = runTest {
        val executed = mutableListOf<String>()

        val build = Build()
        build.task("task1") {
            input(virtual("input1") { "sig1" })
            output(virtual("output1"))
            action { executed += "task1" }
        }

        val result = build.run()

        assertTrue(result.success)
        assertEquals(1, result.executed.size)
        assertEquals(listOf("task1"), executed)
    }

    @Test
    fun testTaskSkippedOnSecondRun() = runTest {
        val executed = mutableListOf<String>()
        val state = MemoryState()

        // First run - task should execute
        val build1 = Build(state)
        build1.task("task1") {
            input(virtual("input1") { "sig1" })
            output(virtual("output1"))
            action { executed += "task1" }
        }

        val result1 = build1.run()
        assertEquals(1, result1.executed.size)
        assertEquals(listOf("task1"), executed)

        // Second run - task should be skipped (same inputs)
        executed.clear()
        val build2 = Build(state)
        build2.task("task1") {
            input(virtual("input1") { "sig1" })
            output(virtual("output1"))
            action { executed += "task1" }
        }

        val result2 = build2.run()
        assertEquals(0, result2.executed.size)
        assertEquals(1, result2.skipped.size)
        assertTrue(executed.isEmpty())
    }

    @Test
    fun testTaskRerunsOnInputChange() = runTest {
        val executed = mutableListOf<String>()
        val state = MemoryState()
        var inputSig = "sig1"

        // First run
        val build1 = Build(state)
        build1.task("task1") {
            input(virtual("input1") { inputSig })
            output(virtual("output1"))
            action { executed += "task1" }
        }
        build1.run()

        // Second run with changed input
        executed.clear()
        inputSig = "sig2"  // Input changed!

        val build2 = Build(state)
        build2.task("task1") {
            input(virtual("input1") { inputSig })
            output(virtual("output1"))
            action { executed += "task1" }
        }

        val result2 = build2.run()
        assertEquals(1, result2.executed.size)
        assertEquals(listOf("task1"), executed)
    }

    @Test
    fun testDependencyOrder() = runTest {
        val executed = mutableListOf<String>()

        val build = Build()

        // Task B depends on Task A's output
        build.task("taskA") {
            input(virtual("external"))
            output(virtual("intermediate"))
            action { executed += "taskA" }
        }

        build.task("taskB") {
            input(virtual("intermediate"))  // Depends on taskA
            output(virtual("final"))
            action { executed += "taskB" }
        }

        val result = build.run()

        assertTrue(result.success)
        assertEquals(listOf("taskA", "taskB"), executed)
    }

    @Test
    fun testParallelExecution() = runTest {
        val executed = mutableListOf<String>()

        val build = Build()

        // Two independent tasks - should run in parallel
        build.task("task1") {
            input(virtual("input1"))
            output(virtual("output1"))
            action { executed += "task1" }
        }

        build.task("task2") {
            input(virtual("input2"))
            output(virtual("output2"))
            action { executed += "task2" }
        }

        val result = build.run()

        assertTrue(result.success)
        assertEquals(2, result.executed.size)
        // Both should have executed (order may vary due to parallelism)
        assertTrue("task1" in executed)
        assertTrue("task2" in executed)
    }

    @Test
    fun testPlan() {
        val build = Build()

        build.task("taskA") {
            input(virtual("external"))
            output(virtual("intermediate"))
            action { }
        }

        build.task("taskB") {
            input(virtual("intermediate"))
            output(virtual("final"))
            action { }
        }

        val plan = build.plan()

        assertEquals(2, plan.size)
        assertEquals("taskA", plan[0].id)
        assertEquals("taskB", plan[1].id)
    }

    @Test
    fun testOutputsAndInputs() {
        val build = Build()

        build.task("task1") {
            input(virtual("input1"))
            input(virtual("input2"))
            output(virtual("output1"))
            action { }
        }

        assertEquals(setOf("input1", "input2"), build.inputs().map { it.id }.toSet())
        assertEquals(setOf("output1"), build.outputs().map { it.id }.toSet())
        assertEquals(setOf("input1", "input2"), build.externalInputs().map { it.id }.toSet())
    }

    @Test
    fun testFailFast() = runTest {
        val executed = mutableListOf<String>()

        val build = Build()

        build.task("taskA") {
            input(virtual("external"))
            output(virtual("intermediate"))
            action {
                executed += "taskA"
                throw RuntimeException("Task A failed!")
            }
        }

        build.task("taskB") {
            input(virtual("intermediate"))
            output(virtual("final"))
            action { executed += "taskB" }
        }

        val result = build.run()

        assertTrue(!result.success)
        // Both tasks fail: taskA directly, taskB because its dependency failed
        assertEquals(2, result.failed.size)
        assertEquals(listOf("taskA"), executed)  // taskB should not have run
    }

    @Test
    fun testOnTaskDoneCallback() = runTest {
        val callbacks = mutableListOf<Pair<String, Boolean>>()

        val build = Build()
        build.onTaskDone = { task, executed ->
            callbacks += task.id to executed
        }

        build.task("task1") {
            input(virtual("input1"))
            output(virtual("output1"))
            action { }
        }

        build.run()

        assertEquals(listOf("task1" to true), callbacks)
    }

    @Test
    fun testPerTaskOnDoneHook() = runTest {
        val taskHookCalls = mutableListOf<Pair<String, Boolean>>()
        val state = MemoryState()

        // First run - task executes
        val build1 = Build(state)
        build1.task("task1") {
            input(virtual("input1") { "sig1" })
            output(virtual("output1"))
            action { }
            onDone { executed -> taskHookCalls += "task1" to executed }
        }

        build1.run()
        assertEquals(listOf("task1" to true), taskHookCalls)

        // Second run - task skipped but hook still fires
        taskHookCalls.clear()
        val build2 = Build(state)
        build2.task("task1") {
            input(virtual("input1") { "sig1" })
            output(virtual("output1"))
            action { }
            onDone { executed -> taskHookCalls += "task1" to executed }
        }

        build2.run()
        assertEquals(listOf("task1" to false), taskHookCalls)  // false = skipped
    }

    // ===== Dynamic Task Tests =====

    @Test
    fun testDynamicTaskAddition() = runTest {
        val executed = mutableListOf<String>()

        val build = Build()

        build.task("discover") {
            input(virtual("config"))
            output(virtual("discovery-done"))
            action {
                executed += "discover"
                // Dynamically add tasks
                task("dynamic1") {
                    input(virtual("discovery-done"))
                    output(virtual("dynamic1-output"))
                    action { executed += "dynamic1" }
                }
                task("dynamic2") {
                    input(virtual("discovery-done"))
                    output(virtual("dynamic2-output"))
                    action { executed += "dynamic2" }
                }
            }
        }

        val result = build.run()

        assertTrue(result.success)
        assertEquals(3, result.executed.size)
        assertEquals("discover", executed.first())
        assertTrue("dynamic1" in executed)
        assertTrue("dynamic2" in executed)
    }

    @Test
    fun testDynamicTaskDependsOnExisting() = runTest {
        val executed = mutableListOf<String>()

        val build = Build()

        build.task("setup") {
            output(virtual("setup-done"))
            action { executed += "setup" }
        }

        build.task("discover") {
            input(virtual("setup-done"))
            output(virtual("discovery-done"))
            action {
                executed += "discover"
                // Dynamic task depends on existing task's output
                task("process") {
                    input(virtual("setup-done"))  // Already exists
                    input(virtual("discovery-done"))
                    output(virtual("processed"))
                    action { executed += "process" }
                }
            }
        }

        val result = build.run()

        assertTrue(result.success)
        assertEquals(3, result.executed.size)
        // Order: setup, discover, process
        assertEquals("setup", executed[0])
        assertEquals("discover", executed[1])
        assertEquals("process", executed[2])
    }

    @Test
    fun testNestedDynamicTasks() = runTest {
        val executed = mutableListOf<String>()

        val build = Build()

        build.task("level0") {
            output(virtual("level0-done"))
            action {
                executed += "level0"
                task("level1") {
                    input(virtual("level0-done"))
                    output(virtual("level1-done"))
                    action {
                        executed += "level1"
                        task("level2") {
                            input(virtual("level1-done"))
                            output(virtual("level2-done"))
                            action { executed += "level2" }
                        }
                    }
                }
            }
        }

        val result = build.run()

        assertTrue(result.success)
        assertEquals(listOf("level0", "level1", "level2"), executed)
    }

    @Test
    fun testDynamicTaskWithAddTask() = runTest {
        val executed = mutableListOf<String>()

        val build = Build()

        build.task("discover") {
            output(virtual("discovery-done"))
            action {
                executed += "discover"
                // Use addTask directly instead of DSL
                addTask(Task(
                    id = "dynamic-direct",
                    inputs = setOf(virtual("discovery-done")),
                    outputs = setOf(virtual("dynamic-output")),
                    action = { executed += "dynamic-direct" }
                ))
            }
        }

        val result = build.run()

        assertTrue(result.success)
        assertEquals(2, result.executed.size)
        assertEquals(listOf("discover", "dynamic-direct"), executed)
    }
}
