/**
 * Remotion CLI configuration (loaded only by the Remotion toolchain).
 * See https://www.remotion.dev/docs/config
 */
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setConcurrency(null); // let Remotion pick based on CPU
