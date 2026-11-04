import { describe, expect, test } from "bun:test";
import { discoverForgeHosts, ghHosts, glabHosts } from "./hosts";

const GLAB = `git_protocol: ssh
host: https://gitlab.default.org
hosts:
    gitlab.com:
        api_protocol: https
        token:
    gitlab.default.org:
        api_host: gitlab.default.org
    gitlab.one.org:
        token: glpat-secret
        user: me
    gitlab.two.org:
        is_keyring_token: true
last_update_check_timestamp: "2026"
`;

const GH = `github.com:
    git_protocol: https
    users:
        me:
    user: me
ghe.example.com:
    user: me
`;

describe("forge hosts from the logins", () => {
  test("glab: hosts with a token, a keyring token, or the default", () => {
    expect(glabHosts(GLAB)).toEqual([
      "gitlab.default.org",
      "gitlab.one.org",
      "gitlab.two.org",
    ]);
  });

  test("gh: every host of hosts.yml", () => {
    expect(ghHosts(GH)).toEqual(["github.com", "ghe.example.com"]);
  });

  test("both together, without the files' other content", () => {
    const hosts = discoverForgeHosts((path) => (path === "glab" ? GLAB : GH), {
      glab: "glab",
      gh: "gh",
    });
    expect(hosts).toEqual([
      { host: "gitlab.default.org", provider: "gitlab" },
      { host: "gitlab.one.org", provider: "gitlab" },
      { host: "gitlab.two.org", provider: "gitlab" },
      { host: "github.com", provider: "github" },
      { host: "ghe.example.com", provider: "github" },
    ]);
    expect(JSON.stringify(hosts)).not.toContain("secret");
  });

  test("no configuration: no host", () => {
    expect(discoverForgeHosts(() => "", { glab: null, gh: null })).toEqual([]);
  });
});
