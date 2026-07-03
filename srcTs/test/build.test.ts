import { describe, test, expect } from "bun:test";
import { Build, Task, virtual, MemoryState } from "../src";

describe("Build", () => {
  test("empty build", async () => {
    const build = new Build();
    const result = await build.run();

    expect(result.success).toBe(true);
    expect(result.executed.size).toBe(0);
    expect(result.skipped.size).toBe(0);
  });

  test("single task", async () => {
    const executed: string[] = [];

    const build = new Build();
    build.add(
      new Task({
        id: "task1",
        inputs: [virtual("input1", async () => "sig1")],
        outputs: [virtual("output1")],
        run: async () => {
          executed.push("task1");
        },
      })
    );

    const result = await build.run();

    expect(result.success).toBe(true);
    expect(result.executed.size).toBe(1);
    expect(executed).toEqual(["task1"]);
  });

  test("task skipped on second run", async () => {
    const executed: string[] = [];
    const state = new MemoryState();

    // First run - task should execute
    const build1 = new Build({ state });
    build1.add(
      new Task({
        id: "task1",
        inputs: [virtual("input1", async () => "sig1")],
        outputs: [virtual("output1")],
        run: async () => {
          executed.push("task1");
        },
      })
    );

    const result1 = await build1.run();
    expect(result1.executed.size).toBe(1);
    expect(executed).toEqual(["task1"]);

    // Second run - task should be skipped (same inputs)
    executed.length = 0;
    const build2 = new Build({ state });
    build2.add(
      new Task({
        id: "task1",
        inputs: [virtual("input1", async () => "sig1")],
        outputs: [virtual("output1")],
        run: async () => {
          executed.push("task1");
        },
      })
    );

    const result2 = await build2.run();
    expect(result2.executed.size).toBe(0);
    expect(result2.skipped.size).toBe(1);
    expect(executed).toEqual([]);
  });

  test("task reruns on input change", async () => {
    const executed: string[] = [];
    const state = new MemoryState();
    let inputSig = "sig1";

    // First run
    const build1 = new Build({ state });
    build1.add(
      new Task({
        id: "task1",
        inputs: [virtual("input1", async () => inputSig)],
        outputs: [virtual("output1")],
        run: async () => {
          executed.push("task1");
        },
      })
    );
    await build1.run();

    // Second run with changed input
    executed.length = 0;
    inputSig = "sig2"; // Input changed!

    const build2 = new Build({ state });
    build2.add(
      new Task({
        id: "task1",
        inputs: [virtual("input1", async () => inputSig)],
        outputs: [virtual("output1")],
        run: async () => {
          executed.push("task1");
        },
      })
    );

    const result2 = await build2.run();
    expect(result2.executed.size).toBe(1);
    expect(executed).toEqual(["task1"]);
  });

  test("dependency order", async () => {
    const executed: string[] = [];

    const build = new Build();

    // Task B depends on Task A's output
    build.add(
      new Task({
        id: "taskA",
        inputs: [virtual("external")],
        outputs: [virtual("intermediate")],
        run: async () => {
          executed.push("taskA");
        },
      })
    );

    build.add(
      new Task({
        id: "taskB",
        inputs: [virtual("intermediate")], // Depends on taskA
        outputs: [virtual("final")],
        run: async () => {
          executed.push("taskB");
        },
      })
    );

    const result = await build.run();

    expect(result.success).toBe(true);
    expect(executed).toEqual(["taskA", "taskB"]);
  });

  test("task addition order does not matter", async () => {
    const executed: string[] = [];

    const build = new Build();

    // Add consumer BEFORE producer - should still work correctly
    build.add(
      new Task({
        id: "consumer",
        inputs: [virtual("data")], // Depends on producer's output
        outputs: [virtual("result")],
        run: async () => {
          executed.push("consumer");
        },
      })
    );

    build.add(
      new Task({
        id: "producer",
        outputs: [virtual("data")], // Produces what consumer needs
        run: async () => {
          executed.push("producer");
        },
      })
    );

    const result = await build.run();

    expect(result.success).toBe(true);
    // Producer must run before consumer, regardless of add order
    expect(executed).toEqual(["producer", "consumer"]);
  });

  test("parallel execution", async () => {
    const executed: string[] = [];

    const build = new Build();

    // Two independent tasks - should run in parallel
    build.add(
      new Task({
        id: "task1",
        inputs: [virtual("input1")],
        outputs: [virtual("output1")],
        run: async () => {
          executed.push("task1");
        },
      })
    );

    build.add(
      new Task({
        id: "task2",
        inputs: [virtual("input2")],
        outputs: [virtual("output2")],
        run: async () => {
          executed.push("task2");
        },
      })
    );

    const result = await build.run();

    expect(result.success).toBe(true);
    expect(result.executed.size).toBe(2);
    // Both should have executed (order may vary due to parallelism)
    expect(executed).toContain("task1");
    expect(executed).toContain("task2");
  });

  test("plan", () => {
    const build = new Build();

    build.add(
      new Task({
        id: "taskA",
        inputs: [virtual("external")],
        outputs: [virtual("intermediate")],
        run: async () => {},
      })
    );

    build.add(
      new Task({
        id: "taskB",
        inputs: [virtual("intermediate")],
        outputs: [virtual("final")],
        run: async () => {},
      })
    );

    const plan = build.plan();

    expect(plan.length).toBe(2);
    expect(plan[0].id).toBe("taskA");
    expect(plan[1].id).toBe("taskB");
  });

  test("outputs and inputs", () => {
    const build = new Build();

    build.add(
      new Task({
        id: "task1",
        inputs: [virtual("input1"), virtual("input2")],
        outputs: [virtual("output1")],
        run: async () => {},
      })
    );

    const inputIds = new Set([...build.inputs()].map((a) => a.id));
    const outputIds = new Set([...build.outputs()].map((a) => a.id));
    const externalIds = new Set([...build.externalInputs()].map((a) => a.id));

    expect(inputIds).toEqual(new Set(["input1", "input2"]));
    expect(outputIds).toEqual(new Set(["output1"]));
    expect(externalIds).toEqual(new Set(["input1", "input2"]));
  });

  test("fail fast", async () => {
    const executed: string[] = [];

    const build = new Build();

    build.add(
      new Task({
        id: "taskA",
        inputs: [virtual("external")],
        outputs: [virtual("intermediate")],
        run: async () => {
          executed.push("taskA");
          throw new Error("Task A failed!");
        },
      })
    );

    build.add(
      new Task({
        id: "taskB",
        inputs: [virtual("intermediate")],
        outputs: [virtual("final")],
        run: async () => {
          executed.push("taskB");
        },
      })
    );

    const result = await build.run();

    expect(result.success).toBe(false);
    // Both tasks fail: taskA directly, taskB because its dependency failed
    expect(result.failed.size).toBe(2);
    expect(executed).toEqual(["taskA"]); // taskB should not have run
  });

  test("onTaskDone callback", async () => {
    const callbacks: Array<[string, boolean]> = [];

    const build = new Build({
      onTaskDone: async (task, executed) => {
        callbacks.push([task.id, executed]);
      },
    });

    build.add(
      new Task({
        id: "task1",
        inputs: [virtual("input1")],
        outputs: [virtual("output1")],
        run: async () => {},
      })
    );

    await build.run();

    expect(callbacks).toEqual([["task1", true]]);
  });

  test("per-task onDone hook", async () => {
    const taskHookCalls: Array<[string, boolean]> = [];
    const state = new MemoryState();

    // First run - task executes
    const build1 = new Build({ state });
    build1.add(
      new Task({
        id: "task1",
        inputs: [virtual("input1", async () => "sig1")],
        outputs: [virtual("output1")],
        run: async () => {},
        onDone: async (executed) => {
          taskHookCalls.push(["task1", executed]);
        },
      })
    );

    await build1.run();
    expect(taskHookCalls).toEqual([["task1", true]]);

    // Second run - task skipped but hook still fires
    taskHookCalls.length = 0;
    const build2 = new Build({ state });
    build2.add(
      new Task({
        id: "task1",
        inputs: [virtual("input1", async () => "sig1")],
        outputs: [virtual("output1")],
        run: async () => {},
        onDone: async (executed) => {
          taskHookCalls.push(["task1", executed]);
        },
      })
    );

    await build2.run();
    expect(taskHookCalls).toEqual([["task1", false]]); // false = skipped
  });
});

describe("Dynamic Tasks", () => {
  test("dynamic task addition", async () => {
    const executed: string[] = [];

    const build = new Build();

    build.add(
      new Task({
        id: "discover",
        inputs: [virtual("config")],
        outputs: [virtual("discovery-done")],
        run: async (ctx) => {
          executed.push("discover");
          // Dynamically add tasks
          ctx.add(
            new Task({
              id: "dynamic1",
              inputs: [virtual("discovery-done")],
              outputs: [virtual("dynamic1-output")],
              run: async () => {
                executed.push("dynamic1");
              },
            })
          );
          ctx.add(
            new Task({
              id: "dynamic2",
              inputs: [virtual("discovery-done")],
              outputs: [virtual("dynamic2-output")],
              run: async () => {
                executed.push("dynamic2");
              },
            })
          );
        },
      })
    );

    const result = await build.run();

    expect(result.success).toBe(true);
    expect(result.executed.size).toBe(3);
    expect(executed[0]).toBe("discover");
    expect(executed).toContain("dynamic1");
    expect(executed).toContain("dynamic2");
  });

  test("dynamic task depends on existing", async () => {
    const executed: string[] = [];

    const build = new Build();

    build.add(
      new Task({
        id: "setup",
        outputs: [virtual("setup-done")],
        run: async () => {
          executed.push("setup");
        },
      })
    );

    build.add(
      new Task({
        id: "discover",
        inputs: [virtual("setup-done")],
        outputs: [virtual("discovery-done")],
        run: async (ctx) => {
          executed.push("discover");
          // Dynamic task depends on existing task's output
          ctx.add(
            new Task({
              id: "process",
              inputs: [virtual("setup-done"), virtual("discovery-done")],
              outputs: [virtual("processed")],
              run: async () => {
                executed.push("process");
              },
            })
          );
        },
      })
    );

    const result = await build.run();

    expect(result.success).toBe(true);
    expect(result.executed.size).toBe(3);
    // Order: setup, discover, process
    expect(executed[0]).toBe("setup");
    expect(executed[1]).toBe("discover");
    expect(executed[2]).toBe("process");
  });

  test("nested dynamic tasks", async () => {
    const executed: string[] = [];

    const build = new Build();

    build.add(
      new Task({
        id: "level0",
        outputs: [virtual("level0-done")],
        run: async (ctx) => {
          executed.push("level0");
          ctx.add(
            new Task({
              id: "level1",
              inputs: [virtual("level0-done")],
              outputs: [virtual("level1-done")],
              run: async (ctx) => {
                executed.push("level1");
                ctx.add(
                  new Task({
                    id: "level2",
                    inputs: [virtual("level1-done")],
                    outputs: [virtual("level2-done")],
                    run: async () => {
                      executed.push("level2");
                    },
                  })
                );
              },
            })
          );
        },
      })
    );

    const result = await build.run();

    expect(result.success).toBe(true);
    expect(executed).toEqual(["level0", "level1", "level2"]);
  });
});

describe("Cycle Detection", () => {
  test("detects cycle in task graph", () => {
    const build = new Build();

    // Create a cycle: A -> B -> C -> A
    build.add(
      new Task({
        id: "taskA",
        inputs: [virtual("c-output")],
        outputs: [virtual("a-output")],
        run: async () => {},
      })
    );

    build.add(
      new Task({
        id: "taskB",
        inputs: [virtual("a-output")],
        outputs: [virtual("b-output")],
        run: async () => {},
      })
    );

    build.add(
      new Task({
        id: "taskC",
        inputs: [virtual("b-output")],
        outputs: [virtual("c-output")],
        run: async () => {},
      })
    );

    expect(() => build.plan()).toThrow(/Cycle detected/);
  });
});
