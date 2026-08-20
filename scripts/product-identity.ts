export const PRODUCT_IDENTITY = {
  agent: "Cycle",
  command: "cycle",
  mainPackage: "zcode-cycle",
  product: "ZCode Cycle",
  repository: "https://github.com/jannotix/zcode-cycle-plugin",
  service: "zcode-cycle",
} as const

export const NATIVE_PACKAGE_NAMES = [
  "@zcode-cycle/native-darwin-arm64",
  "@zcode-cycle/native-darwin-x64",
  "@zcode-cycle/native-linux-x64",
  "@zcode-cycle/native-win32-x64",
] as const

export const CERTIFIED_NATIVE_PACKAGE_NAMES = [
  "@zcode-cycle/native-linux-x64",
  "@zcode-cycle/native-win32-x64",
] as const
