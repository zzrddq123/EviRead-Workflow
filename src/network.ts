import * as undici from "undici";

/**
 * Pi CLI configures its HTTP dispatcher during CLI startup. SDK consumers own
 * process startup, so they must perform the equivalent setup themselves.
 */
export function configureSdkNetwork(env: NodeJS.ProcessEnv): void {
  const proxy = (env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy || "").trim();
  if (proxy) {
    process.env.HTTP_PROXY = proxy;
    process.env.HTTPS_PROXY = proxy;
    process.env.http_proxy = proxy;
    process.env.https_proxy = proxy;
  }
  const dispatcher = new undici.EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: 300_000,
    headersTimeout: 300_000,
  });
  undici.setGlobalDispatcher(dispatcher);
  undici.install();
}
