import { render } from "solid-js/web";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import "./styles.css";

registerSW({ immediate: true });
render(() => <App />, document.getElementById("root")!);
