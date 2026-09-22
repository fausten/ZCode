import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSettingService } from "../src/setting/settingService.js";

// fork 兼容回归测试：官方新版会把当前 schema 不认识的顶层键写进同一份 setting.json
// （实证：3.14.1 的 webRemoteControlExternalRelayDevice / webRemoteControlLastEnabledContext，
// 丢失后官方版检测到「部分配对状态」会安全重置，手机连接链接失效）。
// 旧版本写入必须原样保留这些未知键，且不影响已知键的正常更新。
test("settingService 写入保留 schema 未知的顶层键", async () => {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "zcode-setting-unknown-keys-"));
  process.env.HOME = home;
  try {
    const settingsDir = join(home, ".zcode", "v2");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "setting.json"),
      JSON.stringify({
        locale: "en-US",
        webRemoteControlExternalRelayDevice: { deviceSid: "d_test_1234567890" },
        webRemoteControlLastEnabledContext: {
          workspacePath: "/tmp/ws",
          initialTaskId: "sess_test",
        },
        someFutureVendorKey: { nested: [1, 2, 3] },
      }),
      "utf-8",
    );

    const service = createSettingService();
    const before = await service.get();
    assert.equal(before.locale, "en-US");
    await service.update({ locale: "zh-CN" });

    const persisted = JSON.parse(
      await readFile(join(settingsDir, "setting.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.equal(persisted.locale, "zh-CN");
    assert.deepEqual(persisted.webRemoteControlExternalRelayDevice, {
      deviceSid: "d_test_1234567890",
    });
    assert.deepEqual(persisted.webRemoteControlLastEnabledContext, {
      workspacePath: "/tmp/ws",
      initialTaskId: "sess_test",
    });
    assert.deepEqual(persisted.someFutureVendorKey, { nested: [1, 2, 3] });
  } finally {
    process.env.HOME = previousHome;
  }
});
