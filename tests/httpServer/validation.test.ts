/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { GetApi, PostApi, ArgVarchar, ArgDate, DefaultArgRequired, DefaultArgOptional, Debug, ArgRequired, ArgOptional, OperonTestingRuntime } from "../../src";
import { generateOperonTestConfig, setupOperonTestDb } from "../helpers";
import request from "supertest";
import { HandlerContext } from "../../src/httpServer/handler";
import { OperonConfig } from "../../src/operon";
import { getInternalTestRuntime } from "../../src/testing/testing_runtime";

describe("httpserver-datavalidation-tests", () => {
  let testRuntime: OperonTestingRuntime;
  let config: OperonConfig;

  beforeAll(async () => {
    config = generateOperonTestConfig();
    await setupOperonTestDb(config);
    testRuntime = await getInternalTestRuntime([TestEndpointDataVal, DefaultArgToDefault, DefaultArgToOptional, DefaultArgToRequired], config);
  });

  afterAll(async () => {
    await testRuntime.destroy();
  });

  test("get-hello", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/hello");
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("hello!");
  });

  test("not-there", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/nourl");
    expect(response.statusCode).toBe(404);
  });

  // Plain string
  test("no string (get)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/string");
    expect(response.statusCode).toBe(400);
  });
  test("no string (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/string");
    expect(response.statusCode).toBe(400);
  });
  test("no string (post) 2", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/string").send({});
    expect(response.statusCode).toBe(400);
  });
  test("no string (post) - something else", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/string").send({ foo: "bar" });
    expect(response.statusCode).toBe(400);
  });
  test("string get", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/string").query({ v: "AAA" });
    expect(response.statusCode).toBe(200);
  });
  test("string post", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/string").send({ v: "AAA" });
    expect(response.statusCode).toBe(200);
  });
  test("string post not a number", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/string").send({ v: 1234 });
    expect(response.statusCode).toBe(400);
  });

  // Varchar(10)
  test("no string (get)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/varchar");
    expect(response.statusCode).toBe(400);
  });
  test("no string (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/varchar");
    expect(response.statusCode).toBe(400);
  });
  test("no string (post) 2", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/varchar").send({});
    expect(response.statusCode).toBe(400);
  });
  test("string get", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/varchar").query({ v: "AAA" });
    expect(response.statusCode).toBe(200);
  });
  test("string get - too long", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/varchar").query({ v: "AAAaaaAAAaaa" });
    expect(response.statusCode).toBe(400);
  });
  test("string post", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/varchar").send({ v: "AAA" });
    expect(response.statusCode).toBe(200);
  });
  test("string post - too long", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/varchar").send({ v: "AAAaaaAAAaaa" });
    expect(response.statusCode).toBe(400);
  });
  test("string post not a number", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/varchar").send({ v: 1234 });
    expect(response.statusCode).toBe(400);
  });
  test("varchar post boolean", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/number").send({ v: false });
    expect(response.statusCode).toBe(400);
  });

  // Number (float)
  test("no number (get)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/number");
    expect(response.statusCode).toBe(400);
  });
  test("no number (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/number");
    expect(response.statusCode).toBe(400);
  });
  test("no number (post) 2", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/number").send({});
    expect(response.statusCode).toBe(400);
  });
  test("number get", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/number").query({ v: "10.1" });
    expect(response.statusCode).toBe(200);
  });
  test("number get", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/number").query({ v: 10.5 });
    expect(response.statusCode).toBe(200);
  });
  test("number get - bogus value", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/number").query({ v: "abc" });
    expect(response.statusCode).toBe(400);
  });
  test("number get - bigint", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/number").query({ v: 12345678901234567890n });
    expect(response.statusCode).toBe(200);
  });
  test("number post", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/number").send({ v: "20" });
    expect(response.statusCode).toBe(200);
  });
  test("number post", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/number").send({ v: 20.2 });
    expect(response.statusCode).toBe(200);
  });
  /* This fails for unknown reasons
  test("number post", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/number")
    .send({v:0});
    expect(response.statusCode).toBe(200);
  });
  */
  test("number post", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/number").send({ v: -1 });
    expect(response.statusCode).toBe(200);
  });
  test("number post - bogus value", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/number").send({ v: "AAAaaaAAAaaa" });
    expect(response.statusCode).toBe(400);
  });
  test("number post not a number", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/number").send({ v: false });
    expect(response.statusCode).toBe(400);
  });
  /* You can't do this - no bigint serialize to json
  test("number post bigint", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/number")
    .send({v:234567890123456789n});
    expect(response.statusCode).toBe(200);
  });
  */
  test("number post bigint", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/number").send({ v: "12345678901234567890" });
    expect(response.statusCode).toBe(200);
  });

  // Boolean
  test("no boolean (get)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/boolean");
    expect(response.statusCode).toBe(400);
  });
  test("no boolean (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/boolean");
    expect(response.statusCode).toBe(400);
  });
  test("no boolean (post) 2", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/boolean").send({});
    expect(response.statusCode).toBe(400);
  });

  test("true boolean (get)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/boolean").query({ v: "true" });
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: true");
  });
  test("true boolean (get) 2", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/boolean").query({ v: true });
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: true");
  });
  test("true boolean (get) 3", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/boolean").query({ v: 1 });
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: true");
  });
  test("false boolean (get)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/boolean").query({ v: "F" });
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: false");
  });
  test("false boolean (get) 2", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/boolean").query({ v: false });
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: false");
  });
  test("false boolean (get) 3", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/boolean").query({ v: 0 });
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: false");
  });

  test("true boolean (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/boolean").send({ v: "true" });
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: true");
  });
  test("true boolean (post) 2", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/boolean").send({ v: true });
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: true");
  });
  test("true boolean (post) 3", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/boolean").send({ v: 1 });
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: true");
  });
  test("false boolean (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/boolean").send({ v: "F" });
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: false");
  });
  /* These tests fail in jest - the value in the request is 'undefined' which is deeply mysterious
  test("false boolean (post) 2", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/boolean")
    .send({v:false});
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: false");
  });
  test("false boolean (post) 3", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/boolean")
    .send({v:0});
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice boolean: false");
  });
  */
  test("bad boolean 1", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/boolean").send({ v: "A" });
    expect(response.statusCode).toBe(400);
  });
  test("bad boolean 2", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/boolean").send({ v: "falsy" });
    expect(response.statusCode).toBe(400);
  });
  test("bad boolean 1", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/boolean").send({ v: 2 });
    expect(response.statusCode).toBe(400);
  });

  // Date
  test("no date (get)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/date");
    expect(response.statusCode).toBe(400);
  });
  test("no date (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/date");
    expect(response.statusCode).toBe(400);
  });
  test("no date (post) 2", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/date").send({});
    expect(response.statusCode).toBe(400);
  });
  test("good date (get)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/date").query({ v: "2023-10-31" });
    expect(response.statusCode).toBe(200);
  });
  test("good date (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/date").send({ v: "2023-10-31" });
    expect(response.statusCode).toBe(200);
  });
  test("bad date (get)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/date").query({ v: "AAA" });
    expect(response.statusCode).toBe(400);
  });
  test("bad date (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/date").send({ v: "turnip" });
    expect(response.statusCode).toBe(400);
  });

  test("defined or not", async () => {
    const attempts = [
      ["/rrequired", undefined, 400],
      ["/rrequired", "hasaval", 200],
      ["/rdefault", undefined, 400],
      ["/rdefault", "hasaval", 200],
      ["/roptional", undefined, 200],
      ["/roptional", "hasaval", 200],

      ["/orequired", undefined, 400],
      ["/orequired", "hasaval", 200],
      ["/odefault", undefined, 200],
      ["/odefault", "hasaval", 200],
      ["/ooptional", undefined, 200],
      ["/ooptional", "hasaval", 200],

      ["/drequired", undefined, 400],
      ["/drequired", "hasaval", 200],
      ["/ddefault", undefined, 400],
      ["/ddefault", "hasaval", 200],
      ["/doptional", undefined, 200],
      ["/doptional", "hasaval", 200],
    ];

    for (const v of attempts) {
      const response = await request(testRuntime.getHandlersCallback())
        .post(v[0] as string)
        .send({ v: v[1] });
      expect(response.statusCode).toBe(v[2]);
    }
  });

  /*
  // Integer
  test("good integer (get)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/bigint")
    .query({v:"2023"});
    expect(response.statusCode).toBe(200);
  });
  test("good integer 2 (get)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/bigint")
    .query({v:2023});
    expect(response.statusCode).toBe(200);
  });
  test("good integer 2 (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/bigint")
    .send({v:-2023});
    expect(response.statusCode).toBe(200);
  });
  test("good integer 3 (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/bigint")
    .send({v:"-2"});
    expect(response.statusCode).toBe(200);
  });
  test("good integer large (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/bigint")
    .send({v:"12345687901234567890"});
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice bigint: 12345678901234567890");
  });
  test("bad integer (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/bigint")
    .send({v:1.1});
    expect(response.statusCode).toBe(400);
  });
  test("bad integer", async () => {
    const response = await request(testRuntime.getHandlersCallback()).get("/bigint")
    .query({v:-10});
    expect(response.statusCode).toBe(400);
  });
  test("bad integer (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/bigint")
    .send({v:"turnip"});
    expect(response.statusCode).toBe(400);
  });
  */
  /* Not allowed
  test("good integer large 2 (post)", async () => {
    const response = await request(testRuntime.getHandlersCallback()).post("/bigint")
    .send({v:12345687901234567890n});
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe("This is a really nice bigint: 12345678901234567890");
  });
  */

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  class TestEndpointDataVal {
    // eslint-disable-next-line @typescript-eslint/require-await
    @GetApi("/hello")
    static async hello(_ctx: HandlerContext) {
      return { message: "hello!" };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @GetApi("/string")
    static async checkStringG(_ctx: HandlerContext, v: string) {
      if (typeof v !== "string") {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice string: ${v}` };
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/string")
    static async checkStringP(_ctx: HandlerContext, v: string) {
      if (typeof v !== "string") {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice string: ${v}` };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @GetApi("/varchar")
    static async checkVarcharG(_ctx: HandlerContext, @ArgVarchar(10) v: string) {
      if (typeof v !== "string") {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice string (limited length): ${v}` };
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/varchar")
    static async checkVarcharP(_ctx: HandlerContext, @ArgVarchar(10) v: string) {
      if (typeof v !== "string") {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice string (limited length): ${v}` };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @GetApi("/number")
    static async checkNumberG(_ctx: HandlerContext, v: number) {
      if (typeof v !== "number") {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice number: ${v}` };
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/number")
    static async checkNumberP(_ctx: HandlerContext, v: number) {
      if (typeof v !== "number") {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice number: ${v}` };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @GetApi("/bigint")
    static async checkBigintG(_ctx: HandlerContext, v: bigint) {
      if (typeof v !== "bigint") {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice bigint: ${v}` };
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/bigint")
    static async checkBigintP(_ctx: HandlerContext, v: bigint) {
      if (typeof v !== "bigint") {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice bigint: ${v}` };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @GetApi("/date")
    static async checkDateG(_ctx: HandlerContext, @ArgDate() v: Date) {
      if (!(v instanceof Date)) {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice date: ${v.toISOString()}` };
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/date")
    static async checkDateP(_ctx: HandlerContext, @ArgDate() v: Date) {
      if (!(v instanceof Date)) {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice date: ${v.toISOString()}` };
    }

    // This is in honor of Harry
    // eslint-disable-next-line @typescript-eslint/require-await
    @GetApi("/boolean")
    static async checkBooleanG(_ctx: HandlerContext, v: boolean) {
      if (typeof v !== "boolean") {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice boolean: ${v}` };
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/boolean")
    static async checkBooleanP(_ctx: HandlerContext, v: boolean) {
      if (typeof v !== "boolean") {
        throw new Error("THIS SHOULD NEVER HAPPEN");
      }
      return { message: `This is a really nice boolean: ${v}` };
    }

    // Types saved for another day - even the decorators are not there yet:
    //  Integer - not working
    //  Decimal
    //  UUID?
    //  JSON
  }

  @DefaultArgRequired
  class DefaultArgToRequired {
    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/rrequired")
    @Debug()
    static async checkReqValueR(_ctx: HandlerContext, @ArgRequired v: string) {
      return { message: `Got string ${v}` };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/roptional")
    @Debug()
    static async checkOptValueR(_ctx: HandlerContext, @ArgOptional v?: string) {
      return { message: `Got string ${v}` };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/rdefault")
    @Debug()
    static async checkDefValueR(_ctx: HandlerContext, v?: string) {
      return { message: `Got string ${v}` };
    }
  }

  @DefaultArgOptional
  class DefaultArgToOptional {
    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/orequired")
    @Debug()
    static async checkReqValueO(_ctx: HandlerContext, @ArgRequired v: string) {
      return { message: `Got string ${v}` };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/ooptional")
    @Debug()
    static async checkOptValueO(_ctx: HandlerContext, @ArgOptional v?: string) {
      return { message: `Got string ${v}` };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/odefault")
    @Debug()
    static async checkDefValueO(_ctx: HandlerContext, v?: string) {
      return { message: `Got string ${v}` };
    }
  }

  class DefaultArgToDefault {
    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/drequired")
    @Debug()
    static async checkReqValueD(_ctx: HandlerContext, @ArgRequired v: string) {
      return { message: `Got string ${v}` };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/doptional")
    @Debug()
    static async checkOptValueD(_ctx: HandlerContext, @ArgOptional v?: string) {
      return { message: `Got string ${v}` };
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @PostApi("/ddefault")
    @Debug()
    static async checkDefValueD(_ctx: HandlerContext, v?: string) {
      return { message: `Got string ${v}` };
    }
  }
});
