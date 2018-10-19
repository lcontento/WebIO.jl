import createLogger from "debug";
import System from "systemjs";
const debug = createLogger("WebIO:Scope");

import WebIONode, {WebIONodeSchema, WebIONodeContext} from "./Node";
import WebIOObservable, {ObservableData} from "./Observable";
import {getObservableName, ObservableSpecifier, OptionalKeys} from "./utils";
import {WebIOCommand, WebIOMessage} from "./message";
import {evalWithWebIOContext} from "./events";
import WebIODomNode from "./DomNode";
import createNode from "./createNode";
import {BlockImport, importBlock} from "./imports";

/**
 * A map of observable names to arrays-of-listeners that should be
 * evoked when the observable changes.
 *
 * `preDependencies` is a special array-of-listeners which are evoked
 * when all the scope dependencies are loaded.
 */
export interface ScopeListeners {
  preDependencies?: Array<(scope: WebIOScope) => void>;
  [handlerName: string]: Array<((value: any, scope?: WebIOScope) => void)> | undefined;
}

/**
 * Promises associated with a scope.
 */
interface ScopePromises {
  importsLoaded: Promise<any[] | null>;
  connected: Promise<WebIOScope>;
  [promiseName: string]: Promise<any> | undefined;
}

export const SCOPE_NODE_TYPE = "Scope";

/**
 * Data associated with a scope node.
 */
export interface ScopeSchema extends WebIONodeSchema {
  nodeType: typeof SCOPE_NODE_TYPE;

  instanceArgs: {
    /**
     * The id of the scope.
     */
    id: string;

    /**
     * Map from "observableName" => { data about observable }.
     *
     * @example
     * observables = {
     *   "obs-output": {
     *     id: "ob_02",
     *     value: 0.0,
     *     sync: true,
     *   }
     * }
     */
    observables?: {
      [observableName: string]: ObservableData;
    };

    /**
     * Map from "observableName" => ["array", "of", "handlers"] where each handler
     * is specified as a function definition string.
     *
     * @example
     * handlers = {
     *   "obs-output": [
     *     "function (newValue) { console.log('obs-output got ', newValue); }",
     *     "function (newValue) { alert('obs-output got ' + newValue); }"
     *   ]
     * }
     *
     */
    handlers?: {
      [observableName: string]: string[];
    };

    imports?: BlockImport;
  }
}

/**
 * Handlers that are associated with the scope promises.
 *
 * @todo This needs to be refactored.
 */
export interface PromiseHandlers {
  importsLoaded?: string; // (imports: any[] | null) => void;
  // TODO: other promise handlers?
}

class WebIOScope extends WebIONode {

  readonly id: string;
  readonly element: HTMLDivElement;
  children: Array<WebIONode | string> | null = null;
  handlers: ScopeListeners;
  observables: {[observableName: string]: WebIOObservable};
  promises: ScopePromises;

  get dom() { return this.element; }

  constructor(
    schema: ScopeSchema,
    context: WebIONodeContext,
  ) {
    super(schema, context);

    debug("Creating new WebIOScope.", schema);

    this.element = document.createElement("div");
    this.element.className = "webio-scope";
    this.element.setAttribute("data-webio-scope-id",  schema.instanceArgs.id);

    const {id, observables = {}, handlers = {}} = schema.instanceArgs;
    this.id = id;

    // Create WebIOObservables.
    this.observables = {};
    Object.keys(observables).forEach((name) => {
      this.observables[name] = new WebIOObservable(name, observables[name], this);
    });

    this.handlers = {};

    // TODO: refactor registerScope as described elsewhere
    this.webIO.registerScope(this);

    // TODO: this following is super messy and needs to be refactored.
    /**
     * The issue here is that we need to have this.promises hooked up before
     * we create children... and we have to do the imports **after** we create
     * the children. There's definitely a cleaner way to do this but my brain
     * is a little bit fried right now.
     *
     * Currently, we just have a "dummy promise" that we create and then
     * "manually" resolve **after** the imports are done, so that
     * `this.promises` is set when we call `initialize` -- which we need since
     * `initialize` creates children which might in turn (e.g. in the case of
     * {@link ObservableNode}) rely on `this.promises`.
     */
    let resolveImportsLoaded: (...args: any[]) => void;
    let rejectImportsLoaded: (...args: any[]) => void;
    const importsLoadedPromise = new Promise<any[] | null>((resolve, reject) => {
      resolveImportsLoaded = resolve;
      rejectImportsLoaded = reject;
    });
    this.promises = {
      connected: this.webIO.connected.then(() => this),
      importsLoaded: importsLoadedPromise,
    };

    // This is super messy and should be refactored.
    this.initialize(schema)
      .then((...args) => resolveImportsLoaded(args))
      .catch((...args) => rejectImportsLoaded(args));

    this.setupScope();
  }

  /**
   * Perform asynchronous initialization tasks.
   */
  private async initialize(schema: ScopeSchema) {
    const {handlers = {}, imports} = schema.instanceArgs;

    // (Asynchronously) perform dependency initialization
    const {preDependencies = [], _promises = {}, ...restHandlers} = handlers;
    preDependencies
      .map((functionString) => evalWithWebIOContext(this, functionString, {scope: this, webIO: this.webIO}))
      .forEach((handler) => handler.call(this))
    ;

    // Map the function strings into handlers which have `this` bound to the scope's
    // element and which have access to the _webIOScope resources variable (via closure).
    Object.keys(restHandlers).forEach((observableName) => {
      this.handlers[observableName] = handlers[observableName].map((handlerString) => {
        return evalWithWebIOContext(this, handlerString, {scope: this, webIO: this.webIO});
      });
    });

    // Create children WebIONodes.
    this.children = schema.children.map((nodeData) => {
      if (typeof nodeData === "string") {
        return nodeData;
      }
      return createNode(nodeData, {webIO: this.webIO, scope: this})
    });
    // Append children elements to our element.
    for (const child of this.children) {
      if (typeof child === "string") {
        this.element.appendChild(document.createTextNode(child));
      } else {
        this.element.appendChild(child.element);
      }
    }

    const resources = imports ? await importBlock(imports) : null;

    // TypeScript hackery to deal with how promiseHandlers is a very special case
    const {importsLoaded: importsLoadedHandler} = _promises as any as PromiseHandlers;
    if (resources && importsLoadedHandler) {
      // `as any` is necessary because evalWithWebIOContext normally returns
      // a function which is expected to be an event listener... but this is
      // kind of a special case of that.
      debug("Invoking importsLoaded Scope handler.", {importsLoadedHandler, resources});
      const handler = evalWithWebIOContext(this, importsLoadedHandler, {scope: this, webIO: this.webIO});
      (handler as any)(...resources);
    }

    // This isn't super clean, but this function is used to create the
    // importsLoaded promise, so we need to return the promises.
    // TODO: refactor this
    return resources;
  }

  getLocalObservable(observableName: string) {
    // Only return a "local" observable
    const obs = this.observables[observableName];
    if (!obs) {
      throw new Error(`Scope(id=${this.id}) has no observable named "${observableName}".`)
    }
    return obs;
  }

  getObservable(observable: ObservableSpecifier) {
    if (typeof observable === "string" || observable.scope === this.id) {
      return this.getLocalObservable(getObservableName(observable));
    }

    // Otherwise, let the root WebIO instance find the correct scope and
    // observable.
    return this.webIO.getObservable(observable);
  }

  getObservableValue(observable: ObservableSpecifier) {
    return this.getObservable(observable).value;
  }

  /**
   * Update an observable within the scope.
   * @param observable - The name (or specifier) of the observable to modify.
   * @param value - The value to set the observable to.
   * @param sync - Whether or not to sync the value to Julia. This should always be
   *    false if the update originated from Julia and is just being propogated into
   *    the browser.
   */
  setObservableValue(observable: ObservableSpecifier, value: any, sync: boolean = true) {
    const observableName = getObservableName(observable);
    if (!(observableName in this.observables)) {
      throw new Error(`Scope(id=${this.id}) has no observable named "${observableName}".`)
    }
    debug(`Setting Observable (name: ${observableName}) to "${value}" in WebIOScope (id: ${this.id}).`);
    this.observables[observableName].setValue(value, sync);
    this.evokeListeners(observableName);
  }

  /**
   * Evoke the listeners for an observable with the current value of
   * that observable.
   *
   * @param name - The name of the observable whose listeners should be evoked.
   */
  evokeListeners(name: string) {
    const listeners = this.handlers[name];
    if (!listeners) { return; }
    listeners.forEach((listener) => {
      listener.call(this.element, this.getObservableValue(name), this);
    })
  }

  // /**
  //  * Connect to the WebIO Julia machinery.
  //  */
  // private async connect() {
  //   await this.webIO.connected;
  //   await this.send({
  //     command: WebIOCommand.SETUP_SCOPE,
  //     data: {},
  //   });
  //   return;
  // }

  /**
   * Send the setup-scope message.
   *
   * This informs Julia/WebIO that we want to listen to changes associated
   * with this scope.
   */
  protected setupScope() {
    return this.send({
      command: WebIOCommand.SETUP_SCOPE,
      data: {},
    })
  }

  /**
   * Send a message to the WebIO Julia machinery.
   *
   * Sets the scope id if not specified.
   */
  send({scope = this.id, ...rest}: OptionalKeys<WebIOMessage, "scope">) {
    return this.webIO.send({scope, ...rest});
  }
}

export default WebIOScope;
