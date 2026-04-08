import type { TuiDialogSelectOption } from "@opencode-ai/plugin/tui";
import {
  clearAccounts,
  loadAccounts,
  saveAccountsReplace,
  type AccountStorageV4,
} from "./plugin/storage";

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
          openProviderConnect(api, "Select Google → OAuth with Google (Antigravity), then choose Verify one account.");
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
      openProviderConnect(api, "Select Google → OAuth with Google (Antigravity), then choose Check quotas.");
      break;
    case "action:verify-all":
      openProviderConnect(api, "Select Google → OAuth with Google (Antigravity), then choose Verify all accounts.");
      break;
    case "action:configure-models":
      openProviderConnect(api, "Select Google → OAuth with Google (Antigravity), then choose Configure models.");
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
