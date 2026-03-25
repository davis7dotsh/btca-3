type Theme = "light" | "dark";

const STORAGE_KEY = "bc-theme";

const readTheme = (): Theme =>
  typeof localStorage !== "undefined"
    ? ((localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "dark")
    : "dark";

let current = $state<Theme>(readTheme());

export const theme = {
  get current() {
    return current;
  },
  get isDark() {
    return current === "dark";
  },
  set(nextTheme: Theme) {
    current = nextTheme;
    localStorage.setItem(STORAGE_KEY, current);
    document.documentElement.setAttribute("data-theme", current);
  },
  toggle() {
    theme.set(current === "dark" ? "light" : "dark");
  },
};
