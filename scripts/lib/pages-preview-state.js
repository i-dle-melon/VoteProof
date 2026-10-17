// Build-only presentation state. These are UI selectors, never credentials.
const choices = {
  identity: ["guest", "member", "blocked", "admin", "super_admin", "reviewer"],
  gate: ["on", "off"],nickname:["duplicate","unique"],review:["success","error","partial"],
  data: ["normal", "empty", "error"],
  announcement:["off","on","locked","future","expired"],
  exports: ['normal','small','empty','error'],
  theme: ["dark", "light"],
  submission: ["zero", "multi", "twenty", "uploading", "success", "failed"],
  analysis: ["pending", "processing", "clear", "exact_duplicate", "failed"],
};
const params = new URLSearchParams(globalThis.location?.search ?? "");
export const previewState = Object.freeze(
  Object.fromEntries(
    Object.entries(choices).map(([key, values]) => [
      key,
      values.includes(params.get("preview_" + key))
        ? params.get("preview_" + key)
        : {
            identity: "member",
            gate: "on",nickname:"duplicate",review:"success",
            data: "normal",
            announcement:'off',
            exports: 'normal',
            theme: "dark",
            submission: "zero",
            analysis: "pending",
          }[key],
    ]),
  ),
);
export function previewControlChange(key, value) {
  if (!choices[key]?.includes(value)) return;
  const url = new URL(location.href);
  url.searchParams.set("preview_" + key, value);
  if (key === "identity") url.hash = { guest: "home", member: "member",blocked:'member', admin: "admin",super_admin:'admin',reviewer:'admin' }[value];
  location.replace(url.href);
}
