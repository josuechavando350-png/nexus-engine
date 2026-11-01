import {mountScrollThread} from "./scroll-thread.js";
const definition=await(await fetch("./effect.json")).json();
const controller=mountScrollThread(document.querySelector("#detail"),definition);
window.botMDExample={controller,definition,mountScrollThread};
