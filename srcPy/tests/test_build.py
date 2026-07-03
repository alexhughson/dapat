import pytest
from dapat import Build, Task, virtual, MemoryState


class TestBuild:
    async def test_empty_build(self):
        build = Build()
        result = await build.run()

        assert result.success is True
        assert len(result.executed) == 0
        assert len(result.skipped) == 0

    async def test_single_task(self):
        executed: list[str] = []

        build = Build()
        build.add(
            Task(
                id="task1",
                inputs=[virtual("input1", lambda: "sig1")],
                outputs=[virtual("output1")],
                run=lambda ctx: executed.append("task1") or None,  # type: ignore
            )
        )

        result = await build.run()

        assert result.success is True
        assert len(result.executed) == 1
        assert executed == ["task1"]

    async def test_task_skipped_on_second_run(self):
        executed: list[str] = []
        state = MemoryState()

        # First run - task should execute
        build1 = Build(state=state)
        build1.add(
            Task(
                id="task1",
                inputs=[virtual("input1", lambda: "sig1")],
                outputs=[virtual("output1")],
                run=lambda ctx: executed.append("task1") or None,  # type: ignore
            )
        )

        result1 = await build1.run()
        assert len(result1.executed) == 1
        assert executed == ["task1"]

        # Second run - task should be skipped (same inputs)
        executed.clear()
        build2 = Build(state=state)
        build2.add(
            Task(
                id="task1",
                inputs=[virtual("input1", lambda: "sig1")],
                outputs=[virtual("output1")],
                run=lambda ctx: executed.append("task1") or None,  # type: ignore
            )
        )

        result2 = await build2.run()
        assert len(result2.executed) == 0
        assert len(result2.skipped) == 1
        assert executed == []

    async def test_task_reruns_on_input_change(self):
        executed: list[str] = []
        state = MemoryState()
        input_sig = ["sig1"]

        # First run
        build1 = Build(state=state)
        build1.add(
            Task(
                id="task1",
                inputs=[virtual("input1", lambda: input_sig[0])],
                outputs=[virtual("output1")],
                run=lambda ctx: executed.append("task1") or None,  # type: ignore
            )
        )
        await build1.run()

        # Second run with changed input
        executed.clear()
        input_sig[0] = "sig2"

        build2 = Build(state=state)
        build2.add(
            Task(
                id="task1",
                inputs=[virtual("input1", lambda: input_sig[0])],
                outputs=[virtual("output1")],
                run=lambda ctx: executed.append("task1") or None,  # type: ignore
            )
        )

        result2 = await build2.run()
        assert len(result2.executed) == 1
        assert executed == ["task1"]

    async def test_dependency_order(self):
        executed: list[str] = []

        build = Build()

        # Task B depends on Task A's output
        build.add(
            Task(
                id="taskA",
                inputs=[virtual("external")],
                outputs=[virtual("intermediate")],
                run=lambda ctx: executed.append("taskA") or None,  # type: ignore
            )
        )

        build.add(
            Task(
                id="taskB",
                inputs=[virtual("intermediate")],  # Depends on taskA
                outputs=[virtual("final")],
                run=lambda ctx: executed.append("taskB") or None,  # type: ignore
            )
        )

        result = await build.run()

        assert result.success is True
        assert executed == ["taskA", "taskB"]

    async def test_task_addition_order_does_not_matter(self):
        executed: list[str] = []

        build = Build()

        # Add consumer BEFORE producer - should still work correctly
        build.add(
            Task(
                id="consumer",
                inputs=[virtual("data")],  # Depends on producer's output
                outputs=[virtual("result")],
                run=lambda ctx: executed.append("consumer") or None,  # type: ignore
            )
        )

        build.add(
            Task(
                id="producer",
                outputs=[virtual("data")],  # Produces what consumer needs
                run=lambda ctx: executed.append("producer") or None,  # type: ignore
            )
        )

        result = await build.run()

        assert result.success is True
        # Producer must run before consumer, regardless of add order
        assert executed == ["producer", "consumer"]

    async def test_parallel_execution(self):
        executed: list[str] = []

        build = Build()

        # Two independent tasks - should run in parallel
        build.add(
            Task(
                id="task1",
                inputs=[virtual("input1")],
                outputs=[virtual("output1")],
                run=lambda ctx: executed.append("task1") or None,  # type: ignore
            )
        )

        build.add(
            Task(
                id="task2",
                inputs=[virtual("input2")],
                outputs=[virtual("output2")],
                run=lambda ctx: executed.append("task2") or None,  # type: ignore
            )
        )

        result = await build.run()

        assert result.success is True
        assert len(result.executed) == 2
        # Both should have executed (order may vary due to parallelism)
        assert "task1" in executed
        assert "task2" in executed

    def test_plan(self):
        build = Build()

        build.add(
            Task(
                id="taskA",
                inputs=[virtual("external")],
                outputs=[virtual("intermediate")],
                run=lambda ctx: None,  # type: ignore
            )
        )

        build.add(
            Task(
                id="taskB",
                inputs=[virtual("intermediate")],
                outputs=[virtual("final")],
                run=lambda ctx: None,  # type: ignore
            )
        )

        plan = build.plan()

        assert len(plan) == 2
        assert plan[0].id == "taskA"
        assert plan[1].id == "taskB"

    def test_outputs_and_inputs(self):
        build = Build()

        build.add(
            Task(
                id="task1",
                inputs=[virtual("input1"), virtual("input2")],
                outputs=[virtual("output1")],
                run=lambda ctx: None,  # type: ignore
            )
        )

        input_ids = {a.id for a in build.inputs()}
        output_ids = {a.id for a in build.outputs()}
        external_ids = {a.id for a in build.external_inputs()}

        assert input_ids == {"input1", "input2"}
        assert output_ids == {"output1"}
        assert external_ids == {"input1", "input2"}

    async def test_fail_fast(self):
        executed: list[str] = []

        build = Build()

        async def fail_task(ctx):
            executed.append("taskA")
            raise Exception("Task A failed!")

        build.add(
            Task(
                id="taskA",
                inputs=[virtual("external")],
                outputs=[virtual("intermediate")],
                run=fail_task,
            )
        )

        build.add(
            Task(
                id="taskB",
                inputs=[virtual("intermediate")],
                outputs=[virtual("final")],
                run=lambda ctx: executed.append("taskB") or None,  # type: ignore
            )
        )

        result = await build.run()

        assert result.success is False
        # Both tasks fail: taskA directly, taskB because its dependency failed
        assert len(result.failed) == 2
        assert executed == ["taskA"]  # taskB should not have run

    async def test_on_task_done_callback(self):
        callbacks: list[tuple[str, bool]] = []

        async def on_done(task: Task, executed: bool):
            callbacks.append((task.id, executed))

        build = Build(on_task_done=on_done)

        build.add(
            Task(
                id="task1",
                inputs=[virtual("input1")],
                outputs=[virtual("output1")],
                run=lambda ctx: None,  # type: ignore
            )
        )

        await build.run()

        assert callbacks == [("task1", True)]

    async def test_per_task_on_done_hook(self):
        task_hook_calls: list[tuple[str, bool]] = []
        state = MemoryState()

        async def on_done(executed: bool):
            task_hook_calls.append(("task1", executed))

        # First run - task executes
        build1 = Build(state=state)
        build1.add(
            Task(
                id="task1",
                inputs=[virtual("input1", lambda: "sig1")],
                outputs=[virtual("output1")],
                run=lambda ctx: None,  # type: ignore
                on_done=on_done,
            )
        )

        await build1.run()
        assert task_hook_calls == [("task1", True)]

        # Second run - task skipped but hook still fires
        task_hook_calls.clear()
        build2 = Build(state=state)
        build2.add(
            Task(
                id="task1",
                inputs=[virtual("input1", lambda: "sig1")],
                outputs=[virtual("output1")],
                run=lambda ctx: None,  # type: ignore
                on_done=on_done,
            )
        )

        await build2.run()
        assert task_hook_calls == [("task1", False)]  # false = skipped


class TestDynamicTasks:
    async def test_dynamic_task_addition(self):
        executed: list[str] = []

        build = Build()

        async def discover_run(ctx):
            executed.append("discover")
            # Dynamically add tasks
            ctx.add(
                Task(
                    id="dynamic1",
                    inputs=[virtual("discovery-done")],
                    outputs=[virtual("dynamic1-output")],
                    run=lambda c: executed.append("dynamic1") or None,  # type: ignore
                )
            )
            ctx.add(
                Task(
                    id="dynamic2",
                    inputs=[virtual("discovery-done")],
                    outputs=[virtual("dynamic2-output")],
                    run=lambda c: executed.append("dynamic2") or None,  # type: ignore
                )
            )

        build.add(
            Task(
                id="discover",
                inputs=[virtual("config")],
                outputs=[virtual("discovery-done")],
                run=discover_run,
            )
        )

        result = await build.run()

        assert result.success is True
        assert len(result.executed) == 3
        assert executed[0] == "discover"
        assert "dynamic1" in executed
        assert "dynamic2" in executed

    async def test_dynamic_task_depends_on_existing(self):
        executed: list[str] = []

        build = Build()

        build.add(
            Task(
                id="setup",
                outputs=[virtual("setup-done")],
                run=lambda ctx: executed.append("setup") or None,  # type: ignore
            )
        )

        async def discover_run(ctx):
            executed.append("discover")
            # Dynamic task depends on existing task's output
            ctx.add(
                Task(
                    id="process",
                    inputs=[virtual("setup-done"), virtual("discovery-done")],
                    outputs=[virtual("processed")],
                    run=lambda c: executed.append("process") or None,  # type: ignore
                )
            )

        build.add(
            Task(
                id="discover",
                inputs=[virtual("setup-done")],
                outputs=[virtual("discovery-done")],
                run=discover_run,
            )
        )

        result = await build.run()

        assert result.success is True
        assert len(result.executed) == 3
        # Order: setup, discover, process
        assert executed[0] == "setup"
        assert executed[1] == "discover"
        assert executed[2] == "process"

    async def test_nested_dynamic_tasks(self):
        executed: list[str] = []

        build = Build()

        async def level0_run(ctx):
            executed.append("level0")

            async def level1_run(ctx):
                executed.append("level1")
                ctx.add(
                    Task(
                        id="level2",
                        inputs=[virtual("level1-done")],
                        outputs=[virtual("level2-done")],
                        run=lambda c: executed.append("level2") or None,  # type: ignore
                    )
                )

            ctx.add(
                Task(
                    id="level1",
                    inputs=[virtual("level0-done")],
                    outputs=[virtual("level1-done")],
                    run=level1_run,
                )
            )

        build.add(
            Task(
                id="level0",
                outputs=[virtual("level0-done")],
                run=level0_run,
            )
        )

        result = await build.run()

        assert result.success is True
        assert executed == ["level0", "level1", "level2"]


class TestCycleDetection:
    def test_detects_cycle_in_task_graph(self):
        build = Build()

        # Create a cycle: A -> B -> C -> A
        build.add(
            Task(
                id="taskA",
                inputs=[virtual("c-output")],
                outputs=[virtual("a-output")],
                run=lambda ctx: None,  # type: ignore
            )
        )

        build.add(
            Task(
                id="taskB",
                inputs=[virtual("a-output")],
                outputs=[virtual("b-output")],
                run=lambda ctx: None,  # type: ignore
            )
        )

        build.add(
            Task(
                id="taskC",
                inputs=[virtual("b-output")],
                outputs=[virtual("c-output")],
                run=lambda ctx: None,  # type: ignore
            )
        )

        with pytest.raises(ValueError, match="Cycle detected"):
            build.plan()
