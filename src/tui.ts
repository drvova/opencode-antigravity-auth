import type { TuiDialogSelectOption } from "@opencode-ai/plugin/tui";
import { ANTIGRAVITY_PROVIDER_ID } from "./constants";
import {
  clearAccounts,
  loadAccounts,
  saveAccounts,
  saveAccountsReplace,
  type AccountMetadataV3,
  type AccountStorageV4,
} from "./plugin/storage";
import { checkAccountsQuota } from "./plugin/quota";
import { updateOpencodeConfig } from "./plugin/config/updater";
import { verifyAccountAccess } from "./plugin/verification";

const TUI_PLUGIN_ID = "opencode-antigravity-auth:tui";
const COMMAND_OPEN = "antigravity.accounts";
const COMMAND_RELOAD = "antigravity.accounts.reload";

type TuiApi = any;

function accountStatus(now: number, account: any): string {
  if (account.enabled === false) return "disabled";
  if (account.verificationRequired) return "verification-required";
  const limits = account.rateLimitResetTimes;
  if (limits && typeof limits === "object") {
    for (const value of Object.values(limits)) {
      if (typeof value === "number" && value > now) return "rate-limited";
    }
  }
  return "active";
}

function accountLabel(index: number, account: any, currentIndex: number, now: number): string {
  const email = typeof account.email === "string" && account.email.trim()
    ? account.email
    : `Account ${index + 1}`;
  const status = accountStatus(now, account);
  const tags: string[] = [];
  if (index === currentIndex) tags.push("current");
  tags.push(status);
  return `${index + 1}. ${email} [${tags.join("] [")}]`;
}

async function removeAccountByIndex(index: number): Promise<{ ok: boolean; message: string }> {
  const storage = await loadAccounts();
  if (!storage || storage.accounts.length === 0) {
    return { ok: false, message: "No accounts to remove." };
  }
  if (index < 0 || index >= storage.accounts.length) {
    return { ok: false, message: "Invalid account index." };
  }

  const nextAccounts = storage.accounts.filter((_, i) => i !== index);
  let nextIndex = storage.activeIndex;
  if (nextAccounts.length === 0) {
    nextIndex = 0;
  } else if (index === storage.activeIndex) {
    nextIndex = Math.min(index, nextAccounts.length - 1);
  } else if (index < storage.activeIndex) {
    nextIndex = Math.max(0, storage.activeIndex - 1);
  }

  const next: AccountStorageV4 = {
    version: 4,
    accounts: nextAccounts,
    activeIndex: nextIndex,
    activeIndexByFamily: storage.activeIndexByFamily,
  };

  await saveAccountsReplace(next);
  return { ok: true, message: "Account removed." };
}

async function setCurrentIndex(index: number): Promise<{ ok: boolean; message: string }> {
  const storage = await loadAccounts();
  if (!storage || storage.accounts.length === 0) {
    return { ok: false, message: "No accounts available." };
  }
  if (index < 0 || index >= storage.accounts.length) {
    return { ok: false, message: "Invalid account index." };
  }

  const next: AccountStorageV4 = {
    version: 4,
    accounts: storage.accounts,
    activeIndex: index,
    activeIndexByFamily: storage.activeIndexByFamily,
  };

  await saveAccountsReplace(next);
  return { ok: true, message: `Switched current account to #${index + 1}.` };
}

function createDialogSelect(api: TuiApi, props: any): any {
  return api.ui.DialogSelect(props);
}

function formatWaitTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

function formatReset(resetTime?: string): string {
  if (!resetTime) return "";
  const ms = Date.parse(resetTime) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return " (resetting)";
  return ` (resets in ${formatWaitTime(ms)})`;
}

function showTextDialog(api: TuiApi, title: string, lines: string[], onBack?: () => void): void {
  const options: TuiDialogSelectOption<string>[] = [
    ...lines.map((line, i) => ({
      title: line,
      value: `line:${i}`,
      category: "Info",
    })),
    {
      title: "Back",
      value: "back",
      category: "Navigation",
    },
  ];

  api.ui.dialog.setSize("xlarge");
  api.ui.dialog.replace(() =>
    createDialogSelect(api, {
      title,
      options,
      onSelect: (item: TuiDialogSelectOption<string>) => {
        if (item.value === "back") {
          if (onBack) onBack();
        }
      },
    }),
  );
}

function markVerificationRequired(account: AccountMetadataV3, reason: string, verifyUrl?: string): boolean {
  let changed = false;
  if (account.verificationRequired !== true) {
    account.verificationRequired = true;
    changed = true;
  }
  if (account.verificationRequiredAt === undefined) {
    account.verificationRequiredAt = Date.now();
    changed = true;
  }
  const normalizedReason = reason.trim();
  if (account.verificationRequiredReason !== normalizedReason) {
    account.verificationRequiredReason = normalizedReason;
    changed = true;
  }
  const normalizedUrl = verifyUrl?.trim();
  if (normalizedUrl && account.verificationUrl !== normalizedUrl) {
    account.verificationUrl = normalizedUrl;
    changed = true;
  }
  if (account.enabled !== false) {
    account.enabled = false;
    changed = true;
  }
  return changed;
}

function clearVerificationRequired(account: AccountMetadataV3): boolean {
  let changed = false;
  if (account.verificationRequired !== false) {
    account.verificationRequired = false;
    changed = true;
  }
  if (account.verificationRequiredAt !== undefined) {
    account.verificationRequiredAt = undefined;
    changed = true;
  }
  if (account.verificationRequiredReason !== undefined) {
    account.verificationRequiredReason = undefined;
    changed = true;
  }
  if (account.verificationUrl !== undefined) {
    account.verificationUrl = undefined;
    changed = true;
  }
  if (account.enabled === false) {
    account.enabled = true;
    changed = true;
  }
  return changed;
}

async function runQuotaCheck(api: TuiApi): Promise<void> {
  const storage = await loadAccounts();
  if (!storage || storage.accounts.length === 0) {
    api.ui.toast({ variant: "error", message: "No accounts found." });
    return;
  }

  api.ui.toast({ variant: "info", message: `Checking quotas for ${storage.accounts.length} account(s)...` });
  const results = await checkAccountsQuota(storage.accounts, api.client, ANTIGRAVITY_PROVIDER_ID);

  let storageUpdated = false;
  const lines: string[] = [];
  for (const result of results) {
    const label = result.email || `Account ${result.index + 1}`;
    if (result.status === "error") {
      lines.push(`${label}: ERROR - ${result.error ?? "quota fetch failed"}`);
      continue;
    }

    if (result.updatedAccount) {
      storage.accounts[result.index] = {
        ...result.updatedAccount,
        cachedQuota: result.quota?.groups,
        cachedQuotaUpdatedAt: Date.now(),
      };
      storageUpdated = true;
    } else {
      const acc = storage.accounts[result.index];
      if (acc && result.quota?.groups) {
        acc.cachedQuota = result.quota.groups;
        acc.cachedQuotaUpdatedAt = Date.now();
        storageUpdated = true;
      }
    }

    lines.push(`${label}`);
    const claude = result.quota?.groups?.claude;
    const pro = result.quota?.groups?.["gemini-pro"];
    const flash = result.quota?.groups?.["gemini-flash"];

    const formatPct = (fraction?: number) =>
      typeof fraction === "number" ? `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` : "n/a";

    lines.push(`  Antigravity Claude: ${formatPct(claude?.remainingFraction)}${formatReset(claude?.resetTime)}`);
    lines.push(`  Antigravity Gemini Pro: ${formatPct(pro?.remainingFraction)}${formatReset(pro?.resetTime)}`);
    lines.push(`  Antigravity Gemini Flash: ${formatPct(flash?.remainingFraction)}${formatReset(flash?.resetTime)}`);

    if (result.geminiCliQuota?.models?.length) {
      for (const model of result.geminiCliQuota.models) {
        lines.push(
          `  Gemini CLI ${model.modelId}: ${Math.round(model.remainingFraction * 100)}%${formatReset(model.resetTime)}`,
        );
      }
    }
  }

  if (storageUpdated) {
    await saveAccounts(storage);
  }

  showTextDialog(api, "Quota Results", lines, () => showAccountsDialog(api));
}

async function runConfigureModels(api: TuiApi): Promise<void> {
  const result = await updateOpencodeConfig();
  if (!result.success) {
    api.ui.toast({ variant: "error", message: result.error || "Failed to configure models." });
    return;
  }

  showTextDialog(
    api,
    "Models Configured",
    [
      "Antigravity model definitions were written successfully.",
      `Config: ${result.configPath}`,
    ],
    () => showAccountsDialog(api),
  );
}

async function runVerifyAll(api: TuiApi): Promise<void> {
  const storage = await loadAccounts();
  if (!storage || storage.accounts.length === 0) {
    api.ui.toast({ variant: "error", message: "No accounts found." });
    return;
  }

  const lines: string[] = [];
  let changed = false;

  for (let i = 0; i < storage.accounts.length; i++) {
    const account = storage.accounts[i];
    if (!account) continue;
    const label = account.email || `Account ${i + 1}`;

    const verification = await verifyAccountAccess(account, api.client, ANTIGRAVITY_PROVIDER_ID);
    if (verification.status === "ok") {
      if (clearVerificationRequired(account)) changed = true;
      lines.push(`${label}: OK`);
      continue;
    }

    if (verification.status === "blocked") {
      if (markVerificationRequired(account, verification.message, verification.verifyUrl)) changed = true;
      lines.push(`${label}: NEEDS VERIFICATION - ${verification.message}`);
      if (verification.verifyUrl) {
        lines.push(`  URL: ${verification.verifyUrl}`);
      }
      continue;
    }

    lines.push(`${label}: ERROR - ${verification.message}`);
  }

  if (changed) {
    await saveAccountsReplace(storage);
  }

  showTextDialog(api, "Verification Results", lines, () => showAccountsDialog(api));
}

async function runVerifyOne(api: TuiApi, index: number): Promise<void> {
  const storage = await loadAccounts();
  if (!storage || !storage.accounts[index]) {
    api.ui.toast({ variant: "error", message: "Account not found." });
    return;
  }
  const account = storage.accounts[index]!;
  const label = account.email || `Account ${index + 1}`;
  const verification = await verifyAccountAccess(account, api.client, ANTIGRAVITY_PROVIDER_ID);

  if (verification.status === "ok") {
    const changed = clearVerificationRequired(account);
    if (changed) {
      await saveAccountsReplace(storage);
    }
    showTextDialog(api, "Verification Result", [`${label}: OK`], () => showAccountActions(api, index));
    return;
  }

  if (verification.status === "blocked") {
    const changed = markVerificationRequired(account, verification.message, verification.verifyUrl);
    if (changed) {
      await saveAccountsReplace(storage);
    }
    const lines = [`${label}: NEEDS VERIFICATION`, verification.message];
    if (verification.verifyUrl) lines.push(`URL: ${verification.verifyUrl}`);
    showTextDialog(api, "Verification Result", lines, () => showAccountActions(api, index));
    return;
  }

  showTextDialog(api, "Verification Result", [`${label}: ERROR`, verification.message], () => showAccountActions(api, index));
}

function openProviderConnect(api: TuiApi, message?: string): void {
  if (message) {
    api.ui.toast({
      variant: "info",
      message,
    });
  }
  api.ui.dialog.clear();
  api.command.trigger("provider.connect");
}

function showAccountActions(api: TuiApi, index: number): void {
  const options: TuiDialogSelectOption<string>[] = [
    {
      title: "Set as current",
      value: `set-current:${index}`,
      category: "Account",
      description: "Use this account as the active account",
    },
    {
      title: "Verify this account",
      value: `verify:${index}`,
      category: "Account",
      description: "Run verification for this specific account",
    },
    {
      title: "Delete this account",
      value: `delete:${index}`,
      category: "Danger Zone",
      description: "Remove this account from local storage",
    },
    {
      title: "Back",
      value: "back",
      category: "Navigation",
    },
  ];

  api.ui.dialog.replace(() =>
    createDialogSelect(api, {
      title: `Account ${index + 1}`,
      options,
      onSelect: (item: TuiDialogSelectOption<string>) => {
        if (item.value === "back") {
          showAccountsDialog(api);
          return;
        }

        if (item.value.startsWith("set-current:")) {
          const target = Number.parseInt(item.value.split(":")[1] ?? "-1", 10);
          setCurrentIndex(target)
            .then((result) => {
              api.ui.toast({
                variant: result.ok ? "success" : "error",
                message: result.message,
              });
              showAccountsDialog(api);
            })
            .catch((error) => {
              api.ui.toast({
                variant: "error",
                message: error instanceof Error ? error.message : "Failed to update account",
              });
              showAccountsDialog(api);
            });
          return;
        }

        if (item.value.startsWith("verify:")) {
          const target = Number.parseInt(item.value.split(":")[1] ?? "-1", 10);
          void runVerifyOne(api, target);
          return;
        }

        if (item.value.startsWith("delete:")) {
          const target = Number.parseInt(item.value.split(":")[1] ?? "-1", 10);
          removeAccountByIndex(target)
            .then((result) => {
              api.ui.toast({
                variant: result.ok ? "success" : "error",
                message: result.message,
              });
              showAccountsDialog(api);
            })
            .catch((error) => {
              api.ui.toast({
                variant: "error",
                message: error instanceof Error ? error.message : "Failed to delete account",
              });
              showAccountsDialog(api);
            });
        }
      },
    }),
  );
}

function buildOptions(storage: AccountStorageV4 | null): TuiDialogSelectOption<string>[] {
  const now = Date.now();
  const list: TuiDialogSelectOption<string>[] = [
    {
      title: "Add account",
      value: "action:add",
      category: "Actions",
      description: "Run Google OAuth flow in the Antigravity account manager",
    },
    {
      title: "Check quotas",
      value: "action:quota",
      category: "Actions",
      description: "Check usage and reset windows for all stored accounts",
    },
    {
      title: "Verify all accounts",
      value: "action:verify-all",
      category: "Actions",
      description: "Run verification checks across every stored account",
    },
    {
      title: "Configure models",
      value: "action:configure-models",
      category: "Actions",
      description: "Write Antigravity model definitions to opencode.json",
    },
    {
      title: "Reload",
      value: "action:reload",
      category: "Actions",
      description: "Refresh account list from disk",
    },
  ];

  if (!storage || storage.accounts.length === 0) {
    list.push({
      title: "No accounts found",
      value: "info:none",
      category: "Accounts",
      description: "Select Add account to create your first Antigravity account",
      disabled: true,
    });
    return list;
  }

  for (let i = 0; i < storage.accounts.length; i++) {
    const account = storage.accounts[i];
    list.push({
      title: accountLabel(i, account, storage.activeIndex, now),
      value: `account:${i}`,
      category: "Accounts",
      description: "Press Enter to open actions for this account",
    });
  }

  list.push({
    title: "Delete all accounts",
    value: "action:delete-all",
    category: "Danger Zone",
    description: "Remove all saved Antigravity accounts",
  });

  return list;
}

function handleMainAction(api: TuiApi, value: string): void {
  switch (value) {
    case "action:add":
      openProviderConnect(api, "Select Google → OAuth with Google (Antigravity), then choose Add account.");
      break;
    case "action:quota":
      void runQuotaCheck(api);
      break;
    case "action:verify-all":
      void runVerifyAll(api);
      break;
    case "action:configure-models":
      void runConfigureModels(api);
      break;
    case "action:delete-all":
      clearAccounts()
        .then(() => {
          api.ui.toast({ variant: "success", message: "All accounts deleted." });
          showAccountsDialog(api);
        })
        .catch((error) => {
          api.ui.toast({
            variant: "error",
            message: error instanceof Error ? error.message : "Failed to delete accounts",
          });
        });
      break;
    case "action:reload":
      showAccountsDialog(api);
      break;
    default:
      break;
  }
}

function showAccountsDialog(api: TuiApi): void {
  loadAccounts()
    .then((storage) => {
      const options = buildOptions(storage);
      api.ui.dialog.setSize("large");
      api.ui.dialog.replace(() =>
        createDialogSelect(api, {
          title: "Antigravity Accounts",
          options,
          onSelect: (item: TuiDialogSelectOption<string>) => {
            if (item.value.startsWith("account:")) {
              const index = Number.parseInt(item.value.split(":")[1] ?? "-1", 10);
              if (Number.isFinite(index) && index >= 0) {
                showAccountActions(api, index);
              }
              return;
            }
            handleMainAction(api, item.value);
          },
        }),
      );
    })
    .catch((error) => {
      api.ui.toast({
        variant: "error",
        message: error instanceof Error ? error.message : "Failed to load account list",
      });
    });
}

const tui = async (api: TuiApi): Promise<void> => {
  api.command.register(() => [
    {
      title: "Antigravity Accounts",
      value: COMMAND_OPEN,
      category: "Provider",
      description: "Open interactive Antigravity account manager",
      slash: {
        name: "ag-accounts",
        aliases: ["ag"],
      },
      onSelect: () => showAccountsDialog(api),
    },
    {
      title: "Reload Antigravity Accounts",
      value: COMMAND_RELOAD,
      category: "Provider",
      hidden: true,
      onSelect: () => showAccountsDialog(api),
    },
  ]);
};

const plugin = {
  id: TUI_PLUGIN_ID,
  tui,
};

export default plugin;
