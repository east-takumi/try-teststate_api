const fs = require("fs");
const path = require("path");
const { StepFunctionsClient, TestStateCommand } = require("@aws-sdk/client-sfn");

// Load the example state machine once for all tests.
const definition = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../src/statemachine.asl.json"), "utf8")
);

/**
 * Returns a Step Functions client whose send method is already mocked.
 * This keeps the sample fully local while still demonstrating how the
 * TestState API is invoked with the new features.
 */
const buildMockedClient = (mockResponse) => {
  const client = new StepFunctionsClient({ region: "us-east-1" });
  jest.spyOn(client, "send").mockResolvedValue(mockResponse);
  return client;
};

describe("AWS Step Functions TestState API enhancements", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Choice state can be isolated with stateName", async () => {
    const client = buildMockedClient({
      // The service now echoes which state was evaluated when stateName is set.
      inspectedStateName: "DetermineShipping",
      output: JSON.stringify({ shipping: "EXPRESS" })
    });

    const input = { total: 150 };
    const command = new TestStateCommand({
      definition: JSON.stringify(definition),
      input: JSON.stringify(input),
      stateName: "DetermineShipping"
    });

    const response = await client.send(command);

    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: JSON.stringify(input),
        stateName: "DetermineShipping"
      })
    );
    expect(JSON.parse(response.output)).toEqual({ shipping: "EXPRESS" });
    expect(response.inspectedStateName).toBe("DetermineShipping");
  });

  test("Map state supports mocking child states", async () => {
    const client = buildMockedClient({
      output: JSON.stringify({
        packedItems: [
          { id: 1, status: "MOCK_PACKED" },
          { id: 2, status: "MOCK_PACKED" }
        ]
      }),
      mapMocksApplied: ["PackSingleItem"]
    });

    const mapInput = { items: [{ id: 1 }, { id: 2 }] };
    const command = new TestStateCommand({
      definition: JSON.stringify(definition),
      input: JSON.stringify(mapInput),
      stateName: "PackItems",
      // mockConfigurations lets you replace nested states inside Map/Parallel.
      mockConfigurations: [
        {
          stateName: "PackSingleItem",
          mockOutput: { status: "MOCK_PACKED" }
        }
      ]
    });

    const response = await client.send(command);

    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        stateName: "PackItems",
        mockConfigurations: [
          {
            stateName: "PackSingleItem",
            mockOutput: { status: "MOCK_PACKED" }
          }
        ]
      })
    );
    expect(JSON.parse(response.output).packedItems).toHaveLength(2);
    expect(response.mapMocksApplied).toContain("PackSingleItem");
  });

  test("Parallel state exposes errorCausedByState when a branch fails", async () => {
    const client = buildMockedClient({
      error: "FraudulentOrder",
      cause: "Simulated fraud detector failure",
      errorCausedByState: "RunParallelChecks.FraudCheck",
      // Partial successes can still be inspected when mocking is used.
      partialResults: [
        { branch: "InventoryCheck", output: "AVAILABLE" }
      ]
    });

    const command = new TestStateCommand({
      definition: JSON.stringify(definition),
      input: JSON.stringify({ total: 42, items: [{ id: 99 }] }),
      stateName: "RunParallelChecks",
      mockConfigurations: [
        {
          stateName: "FraudCheck",
          mockError: {
            error: "FraudulentOrder",
            cause: "Simulated fraud detector failure"
          }
        }
      ]
    });

    const response = await client.send(command);

    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        stateName: "RunParallelChecks",
        mockConfigurations: [
          {
            stateName: "FraudCheck",
            mockError: {
              error: "FraudulentOrder",
              cause: "Simulated fraud detector failure"
            }
          }
        ]
      })
    );
    expect(response.error).toBe("FraudulentOrder");
    expect(response.errorCausedByState).toBe("RunParallelChecks.FraudCheck");
    expect(response.partialResults[0].branch).toBe("InventoryCheck");
  });
});
