const TUI_PLUGIN_ID = "opencode-antigravity-auth:tui";
const OPEN_ACCOUNTS_COMMAND = "antigravity.accounts.open";

function openAntigravityAccounts(api: any): void {
  try {
    api.ui.toast({
      variant: "info",
      title: "Antigravity",
      message: "Opening provider settings. Select Google → OAuth with Google (Antigravity).",
      duration: 3000,
    });
  } catch {
    // best effort toast
  }

  api.command.trigger("provider.connect");
}

const tui = async (api: any): Promise<void> => {
  api.command.register(() => [
    {
      title: "Antigravity Accounts",
      value: OPEN_ACCOUNTS_COMMAND,
      category: "Provider",
      description: "Open Google provider settings and manage Antigravity accounts",
      slash: {
        name: "ag-accounts",
        aliases: ["ag"],
      },
      onSelect: () => openAntigravityAccounts(api),
    },
  ]);
};

const plugin = {
  id: TUI_PLUGIN_ID,
  tui,
};

export default plugin;
