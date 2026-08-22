import { TrueForge } from "@truefoundry/trueforge-sdk";
import { config } from "../config.js";

export function trueForgeClient(): TrueForge {
  return new TrueForge({ baseUrl: config.trueforgeBaseUrl });
}
