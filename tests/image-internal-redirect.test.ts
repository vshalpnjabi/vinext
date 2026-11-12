import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { handleImageOptimization } from "../packages/vinext/src/server/image-optimization.js";

// Ported from Next.js: test/unit/image-optimizer/fetch-internal-image.test.ts
// https://github.com/vercel/next.js/blob/canary/test/unit/image-optimizer/fetch-internal-image.test.ts
// and test/e2e/image-optimizer-internal-redirect/image-optimizer-internal-redirect.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/image-optimizer-internal-redirect/image-optimizer-internal-redirect.test.ts

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X8n26QAAAABJRU5ErkJggg==",
  "base64",
);

const PNG_RESPONSE = () => new Response(PNG_1X1, { headers: { "Content-Type": "image/png" } });

const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;
const TOO_MANY_REDIRECTS_BODY = '"url" parameter is valid but internal response is invalid';

function imageRequest(source: string) {
  return new Request(`https://example.com/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`);
}

function redirectTo(location: string, status: number = 302) {
  return new Response(null, { status, headers: { Location: location } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleImageOptimization internal source redirects", () => {
  it("follows 301/302/303/307/308 relative redirects to a local PNG", async () => {
    for (const status of REDIRECT_STATUSES) {
      const fetchAsset = vi.fn(async (href: string) =>
        href === "/redirect" ? redirectTo("/test.png", status) : PNG_RESPONSE(),
      );

      const response = await handleImageOptimization(imageRequest("/redirect"), { fetchAsset });

      expect(response.status, String(status)).toBe(200);
      expect(response.headers.get("content-type"), String(status)).toBe("image/png");
      expect(
        fetchAsset.mock.calls.map((call) => call[0]),
        String(status),
      ).toEqual(["/redirect", "/test.png"]);
    }
  });

  it("follows an absolute redirect to a loopback image when dangerouslyAllowLocalIP is set", async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG_1X1);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as AddressInfo;
    const absolute = `http://127.0.0.1:${port}/test.png`;

    try {
      const fetchAsset = vi.fn(async (href: string) => {
        expect(href).toBe("/redirect-absolute");
        return redirectTo(absolute);
      });

      const response = await handleImageOptimization(
        imageRequest("/redirect-absolute"),
        { fetchAsset },
        undefined,
        { dangerouslyAllowLocalIP: true },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_1X1);
      expect(fetchAsset).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects an absolute redirect to a private IP unless dangerouslyAllowLocalIP is set", async () => {
    const fetchAsset = vi.fn(async () => redirectTo("http://127.0.0.1/test.png"));

    const response = await handleImageOptimization(imageRequest("/redirect-absolute"), {
      fetchAsset,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('"url" parameter is not allowed');
    expect(fetchAsset).toHaveBeenCalledOnce();
  });

  it("answers 508 when maximumRedirects is 0", async () => {
    const fetchAsset = vi.fn(async () => redirectTo("/test.png"));

    const response = await handleImageOptimization(
      imageRequest("/redirect"),
      { fetchAsset },
      undefined,
      { maximumRedirects: 0 },
    );

    expect(response.status).toBe(508);
    expect(await response.text()).toBe(TOO_MANY_REDIRECTS_BODY);
    expect(fetchAsset).toHaveBeenCalledOnce();
  });

  it("answers 508 when a redirect chain exceeds maximumRedirects", async () => {
    const fetchAsset = vi.fn(async (href: string) => {
      if (href === "/a") return redirectTo("/b");
      if (href === "/b") return redirectTo("/c");
      if (href === "/c") return redirectTo("/d");
      return PNG_RESPONSE();
    });

    const response = await handleImageOptimization(imageRequest("/a"), { fetchAsset }, undefined, {
      maximumRedirects: 2,
    });

    expect(response.status).toBe(508);
    expect(await response.text()).toBe(TOO_MANY_REDIRECTS_BODY);
    expect(fetchAsset.mock.calls.map((call) => call[0])).toEqual(["/a", "/b", "/c"]);
  });

  it("rejects a protocol-relative redirect Location", async () => {
    const fetchAsset = vi.fn(async () => redirectTo("//example.com/test.png"));

    const response = await handleImageOptimization(imageRequest("/redirect"), { fetchAsset });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('"url" parameter cannot be a protocol-relative URL (//)');
    expect(fetchAsset).toHaveBeenCalledOnce();
  });

  it("rejects a recursive optimizer redirect destination", async () => {
    const fetchAsset = vi.fn(async () => redirectTo("/_next/image?url=%2Ftest.png&w=64&q=75"));

    const response = await handleImageOptimization(imageRequest("/redirect"), { fetchAsset });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('"url" parameter cannot be recursive');
    expect(fetchAsset).toHaveBeenCalledOnce();
  });

  it("does not apply localPatterns to a redirect destination", async () => {
    const fetchAsset = vi.fn(async (href: string) =>
      href === "/allowed.png" ? redirectTo("/blocked.png") : PNG_RESPONSE(),
    );

    const response = await handleImageOptimization(
      imageRequest("/allowed.png"),
      { fetchAsset },
      undefined,
      { localPatterns: [{ pathname: "/allowed.png", search: "" }] },
    );

    expect(response.status).toBe(200);
    expect(fetchAsset.mock.calls.map((call) => call[0])).toEqual(["/allowed.png", "/blocked.png"]);
  });

  it("still rejects an initial source that localPatterns does not allow", async () => {
    const fetchAsset = vi.fn(async () => PNG_RESPONSE());

    const response = await handleImageOptimization(
      imageRequest("/blocked.png"),
      { fetchAsset },
      undefined,
      { localPatterns: [{ pathname: "/allowed.png", search: "" }] },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Bad Request");
    expect(fetchAsset).not.toHaveBeenCalled();
  });
});
