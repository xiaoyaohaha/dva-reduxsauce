// import { combineReducers } from 'redux';
import createSagaMiddleware from 'redux-saga';
import { createReducer } from 'reduxsauce';
import invariant from 'invariant';
// import Immutable from 'seamless-immutable';
import checkModel from './checkModel';
import prefixNamespace from './prefixNamespace';
import Plugin, { filterHooks } from './Plugin';
import createStore from './createStore';
import getSaga from './getSaga';
import getReducer from './getReducer';
import createPromiseMiddleware from './createPromiseMiddleware';
import { run as runSubscription, unlisten as unlistenSubscription } from './subscription';
import * as utils from './utils';

const { noop, findIndex } = utils;

// Internal model to update global state when do unmodel
const dvaModel = {
  namespace: '@@dva',
  state: 0,
  reducers: {
    UPDATE(state) {
      return state + 1;
    },
  },
};

/**
 * Create dva-core instance.
 *
 * @param hooksAndOpts
 * @param createOpts
 */
export function create(hooksAndOpts = {}, createOpts = {}) {
  const { initialReducer, setupApp = noop } = createOpts;

  const plugin = new Plugin();
  // 判断当前传入的参数是不是都是预设的
  plugin.use(filterHooks(hooksAndOpts));

  const app = {
    _models: [prefixNamespace({ ...dvaModel })],
    _store: null,
    _plugin: plugin,
    use: plugin.use.bind(plugin),
    model,
    start,
  };
  return app;

  /**
   * Register model before app is started.
   *
   * @param m {Object} model to register
   */
  function model(m) {
    if (process.env.NODE_ENV !== 'production') {
      // checke一边用户书写的model是否和约定
      checkModel(m, app._models);
    }
    const prefixedModel = prefixNamespace({ ...m });
    app._models.push(prefixedModel);
    return prefixedModel;
  }

  /**
   * Inject model after app is started.
   *
   * @param createReducerFunc
   * @param onError
   * @param unlisteners
   * @param m
   */
  function injectModel(createReducerFunc, onError, unlisteners, m) {
    m = model(m);

    const store = app._store;
    store.asyncReducers = Object.assign({}, m.reducers, store.asyncReducers);
    store.replaceReducer(createReducerFunc());
    if (m.effects) {
      store.runSaga(app._getSaga(m.effects, m, onError, plugin.get('onEffect'), hooksAndOpts));
    }
    if (m.subscriptions) {
      unlisteners[m.namespace] = runSubscription(m.subscriptions, m, app, onError);
    }
  }

  /**
   * Unregister model.
   *
   * @param createReducerFunc
   * @param reducers
   * @param unlisteners
   * @param namespace
   *
   * Unexpected key warn problem:
   * https://github.com/reactjs/redux/issues/1636
   */
  function unmodel(createReducerFunc, reducers, unlisteners, namespace) {
    const store = app._store;

    // Delete reducers
    const asyncReducerKeys = Object.keys(store.asyncReducers);
    const reducersKeys = Object.keys(reducers);
    const undelModels = asyncReducerKeys
      .map(key => {
        return !key.indexOf(`${namespace}/`) >= 0 ? null : asyncReducerKeys[key];
      })
      .filter(i => i);
    const undelReducers = reducersKeys
      .map(key => {
        return !key.indexOf(`${namespace}/`) >= 0 ? null : reducersKeys[key];
      })
      .filter(i => i);
    store.asyncReducers = undelModels;
    reducers = undelReducers;
    store.replaceReducer(createReducerFunc());
    store.dispatch({ type: '@@dva/UPDATE' });

    // Cancel effects
    store.dispatch({ type: `${namespace}/@@CANCEL_EFFECTS` });

    // Unlisten subscrioptions
    unlistenSubscription(unlisteners, namespace);

    // Delete model from app._models
    app._models = app._models.filter(model => model.namespace !== namespace);
  }

  /**
   * Replace a model if it exsits, if not, add it to app
   * Attention:
   * - Only available after dva.start gets called
   * - Will not check origin m is strict equal to the new one
   * Useful for HMR
   * @param createReducerFunc
   * @param reducers
   * @param unlisteners
   * @param onError
   * @param m
   */
  function replaceModel(createReducerFunc, reducers, unlisteners, onError, m) {
    const store = app._store;
    const { namespace } = m;
    const oldModelIdx = findIndex(app._models, model => model.namespace === namespace);

    if (~oldModelIdx) {
      // Cancel effects
      store.dispatch({ type: `${namespace}/@@CANCEL_EFFECTS` });

      // Delete reducers
      const asyncReducerKeys = Object.keys(store.asyncReducers);
      const reducersKeys = Object.keys(reducers);
      const undelModels = asyncReducerKeys
        .map(key => {
          return !key.indexOf(`${namespace}/`) >= 0 ? null : asyncReducerKeys[key];
        })
        .filter(i => i);
      const undelReducers = reducersKeys
        .map(key => {
          return !key.indexOf(`${namespace}/`) >= 0 ? null : reducersKeys[key];
        })
        .filter(i => i);
      store.asyncReducers = undelModels;
      reducers = undelReducers;

      // Unlisten subscrioptions
      unlistenSubscription(unlisteners, namespace);

      // Delete model from app._models
      app._models.splice(oldModelIdx, 1);
    }

    // add new version model to store
    app.model(m);

    store.dispatch({ type: '@@dva/UPDATE' });
  }

  /**
   * Start the app.
   *
   * @returns void
   */
  function start() {
    // Global error handler
    const onError = (err, extension) => {
      if (err) {
        if (typeof err === 'string') err = new Error(err);
        err.preventDefault = () => {
          err._dontReject = true;
        };
        plugin.apply('onError', err => {
          throw new Error(err.stack || err);
        })(err, app._store.dispatch, extension);
      }
    };

    const sagaMiddleware = createSagaMiddleware();
    const promiseMiddleware = createPromiseMiddleware(app);
    app._getSaga = getSaga.bind(null);

    const sagas = [];
    let reducers = {};
    for (const m of app._models) {
      reducers = { ...reducers, ...m.reducers };
      if (m.effects) {
        sagas.push(app._getSaga(m.effects, m, onError, plugin.get('onEffect'), hooksAndOpts));
      }
    }
    console.log(5555, reducers);
    const reducerEnhancer = plugin.get('onReducer');
    const extraReducers = plugin.get('extraReducers');
    invariant(
      Object.keys(extraReducers).every(key => !(key in reducers)),
      `[app.start] extraReducers is conflict with other reducers, reducers list: ${Object.keys(
        reducers,
      ).join(', ')}`,
    );

    // Create store
    console.log(4444, createReducerFunc(), {
      ...reducers,
      ...extraReducers,
      ...(app._store ? app._store.asyncReducers : {}),
    });
    app._store = createStore({
      reducers: createReducerFunc(),
      initialState: hooksAndOpts.initialState || {},
      plugin,
      createOpts,
      sagaMiddleware,
      promiseMiddleware,
    });

    const store = app._store;

    // Extend store
    store.runSaga = sagaMiddleware.run;
    store.asyncReducers = {};

    // Execute listeners when state is changed
    const listeners = plugin.get('onStateChange');
    for (const listener of listeners) {
      store.subscribe(() => {
        listener(store.getState());
      });
    }

    // Run sagas
    sagas.forEach(sagaMiddleware.run);

    // Setup app
    setupApp(app);

    // Run subscriptions
    const unlisteners = {};
    for (const model of this._models) {
      if (model.subscriptions) {
        unlisteners[model.namespace] = runSubscription(model.subscriptions, model, app, onError);
      }
    }

    // Setup app.model and app.unmodel
    app.model = injectModel.bind(app, createReducerFunc, onError, unlisteners);
    app.unmodel = unmodel.bind(app, createReducerFunc, reducers, unlisteners);
    app.replaceModel = replaceModel.bind(app, createReducerFunc, reducers, unlisteners, onError);

    /**
     * Create global reducer for redux.
     *
     * @returns {Object}
     */
    function createReducerFunc() {
      return reducerEnhancer(
        createReducer(hooksAndOpts.initialState || {}, {
          ...reducers,
          ...extraReducers,
          ...(app._store ? app._store.asyncReducers : {}),
        }),
      );
    }
  }
}

export { utils };
