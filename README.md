# xstate-async-guards

This is a helper for using asynchronous guards in [XState](https://xstate.js.org) state machines with ease.

[![npm version](https://img.shields.io/npm/v/xstate-async-guards)](https://npmjs.com/package/xstate-async-guards)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)

## Rationale

Out of the box, XState supports only synchronous, pure condition functions (a.k.a. guards) in [guarded transitions](https://xstate.js.org/docs/guides/guards.html). This makes sense since synchronous transitions undertaken right after an event is received by a state machine are easy to conceptualize.

What if a guard needs external data from some asynchronous API (fetch, IndexedDB, etc.)? What if the guard execution is CPU intensive and you wish to offload it to a Web Worker? XState wants you to perform all async jobs in invoked services (or in spawned actors) which boils down to transitioning to some helper states first. That generates some boilerplate and may obscur your intentions. The problem is exacerbated when there are multiple async guard cases which need to be evaluated sequentially in a waterfall fashion.

The **xstate-async-guards** library provides a `withAsyncGuards` helper to abstract asynchronously guarded transitions like so:

```javascript
// within a state machine declaration
states: {

  Idle: withAsyncGuards({
    on: {
      EVENT: {
        cond: async (_, event) => event.value === 'start', // async function!
        target: '#root.Started'
      }
    }
  }),

  Started: {}
}
```

## Installation

```
$ npm install xstate-async-guards --save
```

## Example

Simply wrap the state node with asynchronous guard functions in a `withAsyncGuards` call:

```javascript
import { withAsyncGuards } from 'xstate-async-guards'

const machine = createMachine({
  id: 'root',
  context: {}, // must not be undefined
  initial: 'Idle',
  states: {
    // this state uses async guards
    Idle: withAsyncGuards({
      on: {
        EVENT: [
          {
            cond: isValueStart, // async function reference
            target: '#root.Started', // must use absolute targets
          },
          {
            cond: 'isValueFaulty', // string reference to an async function in configured guards
            target: '#root.Broken',
            actions: send('BROKEN'), // actions are supported
          },
          {
            target: '#root.Off', // default transition is optional
          },
        ],

        // rejected guard promises can be handled explicitly
        'error.async-guard.isValueStart': {
          actions: (_, event) => console.log('Async guard error!', event),
        },
      },

      id: 'idle', // state ID is mandatory

      // all standard state props are supported. E.g.:
      entry: () => console.log('entered Idle'),
      exit: () => console.log('exited Idle'),
      invoke: {
        /*...*/
      },
      // etc.
    }),

    Started: {},
    Broken: {},
    Off: {},
  },
})
```

[See CodeSandbox here](https://codesandbox.io/s/xstate-async-guards-example-1-tz9b9l?file=/src/machine.js).

## Options

Function `withAsyncGuards` accepts an object as the second argument which may contain the following options:

- `inGuardEvaluation` - an object with `leading` and `trailing` boolean props.
  - `leading` (boolean) - When true (default), `in` guards will be evaluated first, before async guards are evaluated. An async guard will be evaluated only if the `in` guard is satisfied.
  - `trailing` (boolean) - When true, in guards will be evaluated after async guards have been successfully resolved. If an `in` guard is not satisfied at this moment, the transition will not be taken (even though the async guard is satisfied). Defaults to `false`.

## Caution

A thorough consideration should be given to consequences of using asynchronous guards for conditional transitions. Importantly, by the time an async guard resolves, the world may be in a state different from where it was at the time the event triggering the transition was received. Special care should be taken if your state machine uses parallel states or globally defined transitions.

## TODO

- Support combining sync and async guards within the same state node
- Relax the requirement for absolute targets
- Document error handling
