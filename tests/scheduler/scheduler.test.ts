import exp from "constants";
import { Scheduled, TestingRuntime, Workflow, WorkflowContext } from "../../src";
import { DBOSConfig } from "../../src/dbos-executor";
import { createInternalTestRuntime } from "../../src/testing/testing_runtime";
import { sleep } from "../../src/utils";
import { generateDBOSTestConfig, setUpDBOSTestDb } from "../helpers";
import { start } from "repl";

describe("scheduled-wf-tests", () => {
    let config: DBOSConfig;
    let testRuntime: TestingRuntime;
  
    beforeAll(async () => {
        config = generateDBOSTestConfig();
        await setUpDBOSTestDb(config);  
    });
  
    beforeEach(async () => {
        testRuntime = await createInternalTestRuntime([DBOSSchedTestClass], config);
    });
  
    afterEach(async () => {
        await testRuntime.destroy();
    }, 10000);
  
    test("wf-scheduled", async () => {
        await sleep(3);
        expect(DBOSSchedTestClass.nCalls).toBeGreaterThanOrEqual(2);
        expect(DBOSSchedTestClass.nTooEarly).toBeGreaterThanOrEqual(0);
        expect(DBOSSchedTestClass.maxConc).toBeGreaterThanOrEqual(2);
        expect(DBOSSchedTestClass.maxConcLocal).toBeGreaterThanOrEqual(2);
    });
});

class DBOSSchedTestClass {
    static nCalls = 0;
    static nTooEarly = 0;
    static nTooLate = 0;
    static maxConc = 0;
    static maxConcLocal = 0;

    // eslint-disable-next-line @typescript-eslint/require-await
    @Scheduled({crontab: '* * * * * *'})
    @Workflow()
    static async scheduledDefault(ctxt: WorkflowContext, schedTime: Date, startTime: Date, nRunning: number, nRunningHere: number) {
        if (schedTime.getTime() > startTime.getTime()) DBOSSchedTestClass.nTooEarly++;
        if (startTime.getTime() - schedTime.getTime() > 1500) DBOSSchedTestClass.nTooLate++;

        DBOSSchedTestClass.maxConc = Math.max(DBOSSchedTestClass.maxConc, nRunning);
        DBOSSchedTestClass.maxConc = Math.max(DBOSSchedTestClass.maxConc, nRunningHere);

        await ctxt.sleep(2);
    }
}
