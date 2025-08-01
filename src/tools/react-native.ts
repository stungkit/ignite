import { filesystem, GluegunToolbox } from "gluegun"

import { children } from "./filesystem-ext"
import { boolFlag } from "./flag"
import { packager, PackagerName } from "./packager"

export const isAndroidInstalled = (toolbox: GluegunToolbox): boolean => {
  const androidHome = process.env.ANDROID_HOME
  const hasAndroidEnv = !toolbox.strings.isBlank(androidHome)
  const hasAndroid = hasAndroidEnv && toolbox.filesystem.exists(`${androidHome}/tools`) === "dir"

  return Boolean(hasAndroid)
}

type CopyBoilerplateOptions = {
  boilerplatePath: string
  targetPath: string
  excluded: Array<string>
  overwrite?: boolean
}

/**
 * Copies the boilerplate over to the destination folder.
 *
 */
export async function copyBoilerplate(toolbox: GluegunToolbox, options: CopyBoilerplateOptions) {
  const { filesystem } = toolbox
  const { copyAsync, path } = filesystem

  // ensure the destination folder exists
  await filesystem.dirAsync(options.targetPath)

  // rather than copying everything wholesale, let's check what's in the boilerplate folder
  // and copy over everything except stuff like lockfiles and node_modules
  // just to make it faster, y'know? Don't want to copy unnecessary stuff
  const filesAndFolders = children(options.boilerplatePath, true)
  const copyTargets = filesAndFolders.filter(
    (file) => !options.excluded.find((exclusion) => file.includes(exclusion)),
  )

  const { overwrite } = options
  // kick off a bunch of copies
  const copyPromises = copyTargets.map((fileOrFolder) =>
    copyAsync(path(options.boilerplatePath, fileOrFolder), path(options.targetPath, fileOrFolder), {
      ...(overwrite && { overwrite }),
    }),
  )

  // copy them all at once
  return Promise.all(copyPromises)
}

export async function renameReactNativeApp(
  toolbox: GluegunToolbox,
  oldName: string,
  newName: string,
  oldBundleIdentifier: string,
  newBundleIdentifier: string,
) {
  const { parameters, filesystem, print, strings } = toolbox
  const { kebabCase } = strings
  const { path } = filesystem

  // debug?
  const debug = boolFlag(parameters.options.debug)
  const log = <T = unknown>(m: T): T => {
    debug && print.info(` ${m}`)
    return m
  }

  // lower case stuff
  const oldnamelower = oldName.toLowerCase()
  const newnamelower = newName.toLowerCase()

  // kebab case
  const oldnamekebab = kebabCase(oldName)
  const newnamekebab = kebabCase(newName)

  // SCREAMING_SNAKE_CASE
  const oldnamesnake = oldnamelower.replace(/[^a-z0-9]/g, "_").toUpperCase()
  const newnamesnake = newnamelower.replace(/[^a-z0-9]/g, "_").toUpperCase()

  async function rename(oldFile: string, newFile: string) {
    log(`Renaming ${oldFile} to ${newFile}`)
    return filesystem.renameAsync(oldFile, newFile)
  }

  // rename files and folders

  // prettier-ignore
  await Promise.allSettled([
    rename(`ios/${oldName}.xcodeproj/xcshareddata/xcschemes/${oldName}.xcscheme`, `${newName}.xcscheme`),
    rename(`ios/${oldName}Tests/${oldName}Tests.m`, `${newName}Tests.m`),
    rename(`ios/${oldName}/${oldName}-Bridging-Header.h`, `${newName}-Bridging-Header.h`),
    rename(`ios/${oldName}/${oldName}.entitlements`, `${newName}.entitlements`),
    rename(`ios/${oldName}.xcworkspace`, `${newName}.xcworkspace`),
    rename(`ios/${oldName}`, `${newName}`),
  ])

  // these we delay to avoid race conditions
  await Promise.allSettled([
    rename(`ios/${oldName}Tests`, `${newName}Tests`),
    rename(`ios/${oldName}.xcodeproj`, `${newName}.xcodeproj`),
  ])

  // if the bundle identifier / android package name changed,
  // we need to move everything to the new folder structure
  const oldPath = oldBundleIdentifier.replace(/\./g, "/")
  const newPath = newBundleIdentifier.replace(/\./g, "/")

  if (oldBundleIdentifier !== newBundleIdentifier) {
    log(`Renaming bundle identifier to ${newBundleIdentifier}`)

    // move everything at the old bundle identifier path to the new one
    await Promise.allSettled([
      filesystem.moveAsync(
        `android/app/src/main/java/${oldPath}`,
        `android/app/src/main/java/${newPath}`,
      ),
      filesystem.moveAsync(
        `android/app/src/debug/java/${oldPath}`,
        `android/app/src/debug/java/${newPath}`,
      ),
      filesystem.moveAsync(
        `android/app/src/release/java/${oldPath}`,
        `android/app/src/release/java/${newPath}`,
      ),
    ])
  }

  // here's a list of all the files to patch the name in
  const filesToPatch = [
    `app.json`,
    `package.json`,
    `android/settings.gradle`,
    `android/app/_BUCK`,
    `android/app/BUCK`,
    `android/app/build.gradle`,
    `android/app/src/debug/java/${newPath}/ReactNativeFlipper.java`,
    `android/app/src/release/java/${newPath}/ReactNativeFlipper.java`,
    `android/app/src/main/AndroidManifest.xml`,
    `android/app/src/main/java/${newPath}/MainActivity.java`,
    `android/app/src/main/java/${newPath}/MainApplication.java`,
    `android/app/src/main/java/${newPath}/MainApplication.java`,
    `android/app/src/main/java/${newPath}/newarchitecture/MainApplicationReactNativeHost.java`,
    `android/app/src/main/java/${newPath}/newarchitecture/components/MainComponentsRegistry.java`,
    `android/app/src/main/java/${newPath}/newarchitecture/modules/MainApplicationTurboModuleManagerDelegate.java`,
    `android/app/src/main/jni/Android.mk`,
    `android/app/src/main/jni/MainApplicationTurboModuleManagerDelegate.h`,
    `android/app/src/main/jni/MainComponentsRegistry.h`,
    `android/app/src/main/res/values/strings.xml`,
    `ios/Podfile`,
    `ios/main.jsbundle`, // this file could just be regenerated, but this isn't bad to do
    `ios/${newName}/Info.plist`,
    `ios/${newName}.xcodeproj/project.pbxproj`,
    `ios/${newName}.xcodeproj/xcshareddata/xcschemes/${newName}.xcscheme`,
    `ios/${newName}.xcworkspace/contents.xcworkspacedata`,
    `ios/${newName}Tests/${newName}Tests.m`,
    `ios/${newName}/AppDelegate.mm`,
    `ios/${newName}/LaunchScreen.storyboard`,
  ]

  // patch the files
  await Promise.allSettled(
    filesToPatch.map(async (file) => {
      // no need to patch files that don't exist
      const exists = await filesystem.existsAsync(path(file))
      if (!exists) return

      const content = await filesystem.readAsync(path(process.cwd(), file), "utf8")

      log(`Patching ${file} - ${oldName} to ${newName} and variants`)

      // replace all instances of the old name and all its variants
      const newContent = content
        .replace(new RegExp(oldBundleIdentifier, "g"), newBundleIdentifier)
        .replace(new RegExp(oldnamekebab, "g"), newnamekebab)
        .replace(new RegExp(oldnamesnake, "g"), newnamesnake)
        .replace(new RegExp(oldName, "g"), newName)
        .replace(new RegExp(oldnamelower, "g"), newnamelower)

      // write the new content back to the file
      await filesystem.writeAsync(file, newContent, { atomic: true })
    }),
  )
}

export async function replaceMaestroBundleIds(
  toolbox: GluegunToolbox,
  oldBundleIdentifier: string,
  newBundleIdentifier: string,
) {
  const { parameters, filesystem, print } = toolbox
  const { path } = filesystem

  // debug?
  const debug = boolFlag(parameters.options.debug)
  const log = <T = unknown>(m: T): T => {
    debug && print.info(` ${m}`)
    return m
  }

  // here's a list of all the maestro test files to fix the bundle id
  const TARGET_DIR = path(process.cwd())
  const filesToPatch = filesystem.cwd(TARGET_DIR).find({
    matching: `.maestro/**.yaml`,
    files: true,
    directories: false,
  })

  // patch the files
  await Promise.allSettled(
    filesToPatch.map(async (file) => {
      // no need to patch files that don't exist
      const exists = await filesystem.existsAsync(path(file))
      if (!exists) return

      const content = await filesystem.readAsync(path(process.cwd(), file), "utf8")

      log(`Patching ${file} - ${oldBundleIdentifier} to ${newBundleIdentifier} and variants`)

      // replace all instances of the placeholder bundle id with the new one
      const newContent = content.replace(new RegExp(oldBundleIdentifier, "g"), newBundleIdentifier)

      // write the new content back to the file
      await filesystem.writeAsync(file, newContent, { atomic: true })
    }),
  )
}

/**
 * Defines an ejs template for a screen when using Expo Router.
 */
export const EXPO_ROUTER_SCREEN_TEMPLATE = `---
destinationDir: src/screens
---
import { ViewStyle } from "react-native"

import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"

export default function <%= props.pascalCaseName %>Screen() {
  return (
    <Screen style={$root} preset="scroll">
      <Text text="<%= props.camelCaseName %>" />
    </Screen>
  )
}

const $root: ViewStyle = {
  flex: 1,
}
`

/**
 * Defines an ejs template for a route when using Expo Router. The route
 * will be inside the proper `app` directory which will just render the
 * appropriate screen from src/screens.
 */
export const EXPO_ROUTER_ROUTE_TEMPLATE = `---
filename: <%= props.kebabCaseName %>.tsx
---
import { <%= props.pascalCaseName %>Screen } from "@/screens/<%= props.pascalCaseName %>Screen"

export default function <%= props.pascalCaseName %>() {
  return <<%= props.pascalCaseName %>Screen />
}

`

export const EXPO_ROUTER_DYNAMIC_ROUTE_TEMPLATE = `import { <%= props.pascalCaseName %>Screen } from "@/screens/<%= props.pascalCaseName %>Screen"

export default function <%= props.pascalCaseName %>() {
  return <<%= props.pascalCaseName %>Screen />
}

`

export function createGeneratorTemplate(
  toolbox: GluegunToolbox,
  path: string,
  templateEjs: string,
) {
  const { filesystem, parameters, print } = toolbox

  // debug?
  const debug = boolFlag(parameters.options.debug)
  const log = <T = unknown>(m: T): T => {
    debug && print.info(` ${m}`)
    return m
  }

  try {
    filesystem.write(path, templateEjs)
  } catch (e) {
    log(`Unable to write generator template at ${path}.`)
  }
}

export function refactorExpoRouterReactotronCmds(toolbox: GluegunToolbox) {
  const { filesystem, parameters, print } = toolbox

  // debug?
  const debug = boolFlag(parameters.options.debug)
  const log = <T = unknown>(m: T): T => {
    debug && print.info(` ${m}`)
    return m
  }

  try {
    const TARGET_DIR = filesystem.path(process.cwd())
    const reactotronConfigPath = filesystem.path(TARGET_DIR, "src/devtools/ReactotronConfig.ts")

    let reactotronConfig = filesystem.read(reactotronConfigPath)
    reactotronConfig = reactotronConfig
      .replace(/import { goBack, resetRoot, navigate }.*/g, 'import { router } from "expo-router"')
      .replace(/navigate\(route as any\).*/g, "router.push(route)")
      .replace(/goBack\(\).*/g, " router.back()")

    // this one gets removed entirely
    const customCommandToRemoveRegex =
      /reactotron\.onCustomCommand\({\s*title: "Reset Navigation State",\s*description: "Resets the navigation state",\s*command: "resetNavigation",\s*handler: \(\) => {\s*Reactotron\.log\("resetting navigation state"\)\s*resetRoot\({ index: 0, routes: \[\] }\)\s*},\s*}\),?\n?/g
    reactotronConfig = reactotronConfig.replace(customCommandToRemoveRegex, "")

    filesystem.write(reactotronConfigPath, reactotronConfig)
  } catch (e) {
    log(`Unable to update ReactotronConfig.`)
  }
}

export function updateExpoRouterSrcDir(toolbox: GluegunToolbox) {
  const { filesystem, parameters, print } = toolbox

  // debug?
  const debug = boolFlag(parameters.options.debug)
  const log = <T = unknown>(m: T): T => {
    debug && print.info(` ${m}`)
    return m
  }

  const TARGET_DIR = filesystem.path(process.cwd())
  const expoRouterFilesToFix = [
    "tsconfig.json",
    // has its own tsconfig, needs updating separately
    "test/i18n.test.ts",
    "test/setup.ts",
    "ignite/templates/component/NAME.tsx.ejs",
  ]
  expoRouterFilesToFix.forEach((file) => {
    const filePath = filesystem.path(TARGET_DIR, file)
    let fileContents = filesystem.read(filePath)
    try {
      fileContents = fileContents.replace(/app\//g, "src/")
      filesystem.write(filePath, fileContents)
    } catch (e) {
      log(`Unable to locate ${file}.`)
    }
  })
}

export function cleanupExpoRouterConversion(toolbox: GluegunToolbox, targetPath: string) {
  const { filesystem } = toolbox

  const workingDir = filesystem.cwd(targetPath)
  workingDir.cwd("src").remove("app.tsx")
  workingDir.move(
    workingDir.path("src", "screens", "ErrorScreen"),
    workingDir.path("src", "components", "ErrorBoundary"),
  )
  workingDir.remove("index.tsx")
  workingDir.remove(workingDir.path("ignite", "templates", "navigator"))
  workingDir.remove(workingDir.path("src", "navigators"))
  workingDir.remove("app")
}

export function updatePackagerCommandsInReadme(readmePath: string, packagerName: PackagerName) {
  try {
    let readmeContents = filesystem.read(readmePath)

    // replace `yarn` exactly with the install command
    readmeContents = readmeContents.replace("yarn", packager.installCmd({ packagerName }))

    // replace `yarn` plus some command after the space with the proper packager run command
    // pass the matched command to runCmd as string excluding the `yarn` part
    readmeContents = readmeContents.replace(/^yarn\s(.*)$/gm, (_, cmd) =>
      packager.runCmd(cmd, { packagerName }),
    )

    filesystem.write(readmePath, readmeContents)
  } catch (e) {
    console.error("Unable to update README.md.")
  }
}
