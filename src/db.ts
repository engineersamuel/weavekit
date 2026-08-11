import { sqlite } from "@flue/runtime/node";
import { loadTypedWeavekitConfig } from "./config.js";

const config = loadTypedWeavekitConfig();

export default sqlite(`${config.mastermind.sqlitePath}.flue`);
