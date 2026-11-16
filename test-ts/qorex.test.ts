/**
 * The wallet drawer's QoreX module against QoreChain's official QoreX test double
 * (`@qorechain/qorex-wallet-mock`, profile "current": what QoreX does today).
 * No network: the mock derives its accounts locally and the approval is refused
 * before anything would be signed or broadcast.
 */
import { createQorexMock } from "@qorechain/qorex-wallet-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const g = globalThis as unknown as { window?: unknown };

describe("QoreX through @qorechain/qorex-types", () => {
  let mock: ReturnType<typeof createQorexMock>;
  beforeEach(() => {
    g.window = Object.assign(new EventTarget(), { CustomEvent, location: { origin: "http://localhost:5173", hostname: "localhost" } });
    mock = createQorexMock({ profile: "current", autoApprove: false });
    mock.install(g.window as Window);
  });
  afterEach(() => {
    delete g.window;
  });

  it("is detected, connects on qorechain-diana and returns the mock's addresses", async () => {
    const qorex = await import("../apps/web/src/wallet/qorex.ts");
    expect(qorex.available()).toBe(true);
    const connecting = qorex.connect();
    // enable() asks the user once for the site connection; the EVM lane shares it.
    await new Promise((r) => setTimeout(r, 10));
    mock.approveNext();
    const acc = await connecting;
    const want = mock.addresses();
    expect(acc.cosmos).toBe(want.native);
    expect(acc.cosmos.startsWith("qor1")).toBe(true);
    if (acc.evm) expect(acc.evm.toLowerCase()).toBe(want.evm.toLowerCase());
  });

  it("hands the transfer to QoreX's signAndBroadcast, and a refusal in QoreX surfaces as an error", async () => {
    const qorex = await import("../apps/web/src/wallet/qorex.ts");
    const connecting = qorex.connect();
    await new Promise((r) => setTimeout(r, 10));
    mock.approveNext();
    const acc = await connecting;
    mock.rejectNext();
    await expect(qorex.sendQor(acc.cosmos, acc.cosmos, 1n)).rejects.toThrow();
    const sent = mock.requests.filter((r) => r.method.includes("signAndBroadcast"));
    expect(sent.length).toBe(1);
    expect(JSON.stringify(sent[0]!.params)).toContain("/cosmos.bank.v1beta1.MsgSend");
    expect(JSON.stringify(sent[0]!.params)).toContain("qorechain-diana");
  });
});
