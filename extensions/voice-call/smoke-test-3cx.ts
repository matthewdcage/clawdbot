#!/usr/bin/env bun
/**
 * Smoke test: verify SIP REGISTER with 3CX PBX via drachtio-srf.
 * Usage: bun extensions/voice-call/smoke-test-3cx.ts
 */

async function main() {
  // Dynamic CJS import for drachtio-srf
  const Srf = (await import("drachtio-srf")).default;
  const srf = new Srf();

  const cfg = {
    drachtioHost: "127.0.0.1",
    drachtioPort: 9022,
    drachtioSecret: "cymru",
    sipServer: "1442.3cx.cloud",
    sipDomain: "1442.3cx.cloud",
    extension: "17311",
    authId: "xF7XqzYHyW",
    password: "RaQ7yP3zLQ",
  };

  console.log("[smoke] Connecting to drachtio-server...");
  srf.connect({
    host: cfg.drachtioHost,
    port: cfg.drachtioPort,
    secret: cfg.drachtioSecret,
  });

  await new Promise<void>((resolve, reject) => {
    srf.on("connect", () => {
      console.log("[smoke] Connected to drachtio-server");
      resolve();
    });
    srf.on("error", (err: Error) => {
      console.error("[smoke] drachtio connection error:", err.message);
      reject(err);
    });
    setTimeout(() => reject(new Error("drachtio connect timeout")), 10_000);
  });

  console.log(`[smoke] Sending SIP REGISTER to ${cfg.sipServer}...`);
  console.log(`[smoke]   Extension: ${cfg.extension}, AuthID: ${cfg.authId}`);

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error("[smoke] REGISTER timeout after 15s");
      srf.disconnect();
      reject(new Error("REGISTER timeout"));
    }, 15_000);

    srf.request(
      `sip:${cfg.sipDomain}`,
      {
        method: "REGISTER",
        headers: {
          From: `<sip:${cfg.extension}@${cfg.sipDomain}>`,
          To: `<sip:${cfg.extension}@${cfg.sipDomain}>`,
          Contact: `<sip:${cfg.extension}@localhost>`,
          Expires: "120",
          "User-Agent": "OpenClaw/1.0",
        },
        auth: {
          username: cfg.authId,
          password: cfg.password,
        },
      },
      (err: unknown, req: unknown) => {
        if (err) {
          clearTimeout(timeout);
          console.error("[smoke] REGISTER error:", err);
          srf.disconnect();
          reject(err);
          return;
        }

        const r = req as { on: (e: string, cb: (...a: unknown[]) => void) => void };
        r.on("response", (res: { status: number; reason: string }) => {
          clearTimeout(timeout);
          console.log(`[smoke] REGISTER response: ${res.status} ${res.reason}`);

          if (res.status === 200) {
            console.log("[smoke] SUCCESS — registered as extension 17311 on 3CX!");
          } else {
            console.error(`[smoke] FAILED — unexpected status: ${res.status}`);
          }

          // Unregister and disconnect
          srf.request(
            `sip:${cfg.sipDomain}`,
            {
              method: "REGISTER",
              headers: {
                From: `<sip:${cfg.extension}@${cfg.sipDomain}>`,
                To: `<sip:${cfg.extension}@${cfg.sipDomain}>`,
                Contact: `<sip:${cfg.extension}@localhost>`,
                Expires: "0",
                "User-Agent": "OpenClaw/1.0",
              },
              auth: {
                username: cfg.authId,
                password: cfg.password,
              },
            },
            () => {
              console.log("[smoke] Unregistered, disconnecting.");
              srf.disconnect();
              resolve();
            },
          );
        });
      },
    );
  });
}

main()
  .then(() => {
    console.log("[smoke] Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[smoke] Fatal:", err);
    process.exit(1);
  });
