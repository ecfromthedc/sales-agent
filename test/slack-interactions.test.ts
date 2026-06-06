import { describe, it, expect, vi } from "vitest";
import { handleSlackInteraction } from "../src/triggers/slack-interactions";
import { computeSlackSignature } from "../src/lib/slack-verify";
import type { Env } from "../src/lib/env";

// runProposalDrafter must NEVER run for an unauthenticated request. We spy on
// the module so we can assert it was not dispatched.
import * as proposalDrafter from "../src/roles/sales/agents/proposal-drafter";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

function envWith(partial: Partial<Env>): Env {
  return partial as unknown as Env;
}

// A minimal ExecutionContext — waitUntil just swallows the promise.
function ctxStub(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

// Build the form-encoded body Slack actually sends to /slack/interactions.
function interactionBody(dealId: string): string {
  const payload = JSON.stringify({
    type: "block_actions",
    trigger_id: "t",
    user: { id: "U1", name: "eric" },
    actions: [{ action_id: "draft_proposal", value: dealId, block_id: "b" }],
    response_url: "https://hooks.slack.com/actions/x",
    message: { ts: "1.2", blocks: [] },
    channel: { id: "C1" },
  });
  return "payload=" + encodeURIComponent(payload);
}

function makeReq(body: string, headers: Record<string, string>): Request {
  return new Request("https://worker/slack/interactions", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

describe("handleSlackInteraction — signature gate", () => {
  it("rejects an unsigned request with 401 and does not dispatch the drafter", async () => {
    const spy = vi.spyOn(proposalDrafter, "runProposalDrafter").mockResolvedValue(undefined as never);
    const body = interactionBody("deal-123");
    const res = await handleSlackInteraction(
      makeReq(body, {}), // no signature headers
      envWith({ SLACK_SIGNING_SECRET: SECRET }),
      ctxStub(),
    );
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects a request with a wrong signature with 401", async () => {
    const spy = vi.spyOn(proposalDrafter, "runProposalDrafter").mockResolvedValue(undefined as never);
    const body = interactionBody("deal-123");
    const res = await handleSlackInteraction(
      makeReq(body, {
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=" + "0".repeat(64),
      }),
      envWith({ SLACK_SIGNING_SECRET: SECRET }),
      ctxStub(),
    );
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("fails closed (401) when the signing secret is not configured", async () => {
    const body = interactionBody("deal-123");
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await computeSlackSignature(SECRET, ts, body);
    const res = await handleSlackInteraction(
      makeReq(body, { "x-slack-request-timestamp": ts, "x-slack-signature": sig }),
      envWith({ SLACK_SIGNING_SECRET: undefined }),
      ctxStub(),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a correctly signed request (200, signature passes the gate)", async () => {
    // Past the signature gate the handler dispatches via ctx.waitUntil and
    // returns 200 synchronously. We only assert the gate itself here.
    const body = interactionBody("deal-123");
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await computeSlackSignature(SECRET, ts, body);
    const res = await handleSlackInteraction(
      makeReq(body, { "x-slack-request-timestamp": ts, "x-slack-signature": sig }),
      envWith({ SLACK_SIGNING_SECRET: SECRET }),
      ctxStub(),
    );
    expect(res.status).toBe(200);
  });
});
