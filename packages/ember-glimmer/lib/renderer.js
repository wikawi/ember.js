import { RootReference } from './utils/references';
import run from 'ember-metal/run_loop';
import { setHasViews } from 'ember-metal/tags';
import { CURRENT_TAG, UNDEFINED_REFERENCE } from 'glimmer-reference';
import fallbackViewRegistry from 'ember-views/compat/fallback-view-registry';
import { assert } from 'ember-metal/debug';
import _runInTransaction from 'ember-metal/transaction';
import isEnabled from 'ember-metal/features';
import { BOUNDS } from './component';
import { RootComponentDefinition } from './syntax/curly-component';
import { getViewId } from 'ember-views/system/utils';

let runInTransaction;

if (isEnabled('ember-glimmer-detect-backtracking-rerender') ||
    isEnabled('ember-glimmer-allow-backtracking-rerender')) {
  runInTransaction = _runInTransaction;
} else {
  runInTransaction = (context, methodName) => {
    context[methodName]();
    return false;
  };
}

const { backburner } = run;

class DynamicScope {
  constructor(view, outletState, rootOutletState, isTopLevel, targetObject) {
    this.view = view;
    this.outletState = outletState;
    this.rootOutletState = rootOutletState;
    this.isTopLevel = isTopLevel;
    this.targetObject = targetObject;
  }

  child() {
    return new DynamicScope(
      this.view, this.outletState, this.rootOutletState, this.isTopLevel, this.targetObject
    );
  }

  get(key) {
    return this[key];
  }

  set(key, value) {
    this[key] = value;
    return value;
  }
}

class RootState {
  constructor(root, env, template, self, parentElement, dynamicScope) {
    assert(`You cannot render \`${self.value()}\` without a template.`, template);

    this.id = getViewId(root);
    this.root = root;
    this.result = undefined;
    this.shouldReflush = false;

    let options = this.options = {
      alwaysRevalidate: false
    };

    this.render = () => {
      let result = this.result = template.asEntryPoint().render(self, env, {
        appendTo: parentElement,
        dynamicScope
      });

      // override .render function after initial render
      this.render = () => {
        result.rerender(options);
      };
    };
  }

  isFor(possibleRoot) {
    return this.root === possibleRoot;
  }

  destroy() {
    let { result } = this;

    this.root = null;
    this.result = null;
    this.render = null;

    if (result) {
      result.destroy();
    }
  }
}

const renderers = [];

setHasViews(() => renderers.length > 0);

function register(renderer) {
  assert('Cannot register the same renderer twice', renderers.indexOf(renderer) === -1);
  renderers.push(renderer);
}

function deregister(renderer) {
  let index = renderers.indexOf(renderer);
  assert('Cannot deregister unknown unregistered renderer', index !== -1);
  renderers.splice(index, 1);
}

function loopBegin() {
  for (let i = 0; i < renderers.length; i++) {
    renderers[i]._scheduleRevalidate();
  }
}

function K() {}

let loops = 0;
function loopEnd(current, next) {
  for (let i = 0; i < renderers.length; i++) {
    if (!renderers[i]._isValid()) {
      if (loops > 10) {
        loops = 0;
        // TODO: do something better
        renderers[i].destroy();
        throw new Error('infinite rendering invalidation detected');
      }
      loops++;
      return backburner.join(null, K);
    }
  }
  loops = 0;
}

backburner.on('begin', loopBegin);
backburner.on('end', loopEnd);

export class Renderer {
  constructor(env, rootTemplate, _viewRegistry = fallbackViewRegistry, destinedForDOM = false) {
    this._env = env;
    this._rootTemplate = rootTemplate;
    this._viewRegistry = _viewRegistry;
    this._destinedForDOM = destinedForDOM;
    this._destroyed = false;
    this._roots = [];
    this._lastRevision = null;
  }

  // renderer HOOKS

  appendOutletView(view, target) {
    let self = new RootReference(view);
    let targetObject = view.outletState.render.controller;
    let ref = view.toReference();
    let dynamicScope = new DynamicScope(null, ref, ref, true, targetObject);
    let root = new RootState(view, this._env, view.template, self, target, dynamicScope);

    this._renderRoot(root);
  }

  appendTo(view, target) {
    let rootDef = new RootComponentDefinition(view);
    let self = new RootReference(rootDef);
    let dynamicScope = new DynamicScope(null, UNDEFINED_REFERENCE, UNDEFINED_REFERENCE, true, null);
    let root = new RootState(view, this._env, this._rootTemplate, self, target, dynamicScope);

    this._renderRoot(root);
  }

  rerender(view) {
    this._scheduleRevalidate();
  }

  componentInitAttrs() {
    // TODO: Remove me
  }

  ensureViewNotRendering() {
    // TODO: Implement this
    // throw new Error('Something you did caused a view to re-render after it rendered but before it was inserted into the DOM.');
  }

  register(view) {
    let id = getViewId(view);
    assert('Attempted to register a view with an id already in use: ' + id, !this._viewRegistry[id]);
    this._viewRegistry[id] = view;
  }

  unregister(view) {
    delete this._viewRegistry[getViewId(view)];
  }

  remove(view) {
    view.trigger('willDestroyElement');
    view.trigger('willClearRender');
    view._transitionTo('destroying');

    let roots = this._roots;

    // traverse in reverse so we can remove items
    // without mucking up the index
    let i = this._roots.length;
    while (i--) {
      let root = roots[i];
      // check if the view being removed is a root view
      if (root.isFor(view)) {
        root.destroy();
        roots.splice(i, 1);
      }
    }

    if (this._roots.length === 0) {
      deregister(this);
    }

    if (!view.isDestroying) {
      view.destroy();
    }
  }

  destroy() {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this._clearAllRoots();
  }

  getBounds(view) {
    let bounds = view[BOUNDS];

    let parentElement = bounds.parentElement();
    let firstNode = bounds.firstNode();
    let lastNode = bounds.lastNode();

    return { parentElement, firstNode, lastNode };
  }

  createElement(tagName) {
    return this._env.getAppendOperations().createElement(tagName);
  }

  _renderRoot(root) {
    let { _roots: roots } = this;

    roots.push(root);

    if (roots.length === 1) {
      register(this);
    }

    this._renderRootsTransaction();
  }

  _renderRoots() {
    let { _roots: roots, _env: env } = this;
    let globalShouldReflush;

    // ensure that for the first iteration of the loop
    // each root is processed
    let initial = true;

    do {
      env.begin();
      globalShouldReflush = false;

      for (let i = 0; i < roots.length; i++) {
        let root = roots[i];
        let { shouldReflush } = root;

        // when processing non-initial reflush loops,
        // do not process more roots than needed
        if (!initial && !shouldReflush) {
          continue;
        }

        root.options.alwaysRevalidate = shouldReflush;
        // track shouldReflush based on this roots render result
        shouldReflush = root.shouldReflush = runInTransaction(root, 'render');

        // globalShouldReflush should be `true` if *any* of
        // the roots need to reflush
        globalShouldReflush = globalShouldReflush || shouldReflush;
      }

      this._lastRevision = CURRENT_TAG.value();
      env.commit();

      initial = false;
    } while (globalShouldReflush);
  }

  _renderRootsTransaction() {
    try {
      this._renderRoots();
    } catch (e) {
      this.destroy();
      throw e;
    }
  }

  _clearAllRoots() {
    let roots = this._roots;
    for (let i = 0; i < roots.length; i++) {
      let root = roots[i];
      root.destroy();
    }
    this._roots = null;

    if (roots.length) {
      deregister(this);
    }
  }

  _scheduleRevalidate() {
    backburner.scheduleOnce('render', this, this._revalidate);
  }

  _isValid() {
    return this._destroyed || this._roots.length === 0 || CURRENT_TAG.validate(this._lastRevision);
  }

  _revalidate() {
    if (this._isValid()) {
      return;
    }
    this._renderRootsTransaction();
  }
}

export const InertRenderer = {
  create({ env, rootTemplate, _viewRegistry }) {
    return new Renderer(env, rootTemplate, _viewRegistry, false);
  }
};

export const InteractiveRenderer = {
  create({ env, rootTemplate, _viewRegistry }) {
    return new Renderer(env, rootTemplate, _viewRegistry, true);
  }
};
