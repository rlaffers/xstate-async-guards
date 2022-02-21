import { actions, spawn } from 'xstate'

const { assign, send, stop } = actions

/**
 * Wraps an async function in a callback service and calls it with the original event (if specified).
 * On promise resolution, the original event is passed on.
 *
 * @param {function} asyncGuard
 * @param {Object} context
 * @param {Object} event
 * @param {string} guardID
 * @return {function} The returned function is a callback service.
 */
function withOriginalEvent(asyncGuard, context, event, guardID) {
  return (sendBack) => {
    const originalEvent = event.originalEvent ?? event
    asyncGuard(context, originalEvent)
      .then((result) => {
        sendBack({
          type: `done.async-guard.${guardID}`,
          originalEvent,
          result,
        })
      })
      .catch((error) => {
        sendBack({ type: `error.async-guard.${guardID}`, error })
      })
  }
}

/**
 * Guard.
 * @param {Object} context
 * @param {Object} event
 * @return {boolean}
 */
function isResultTrue(context, { result }) {
  return result === true
}

/**
 * @param {string} event
 * @param {number} step
 * @return {string}
 */
function makeStateName(event, step) {
  return `async-guards-${event.replaceAll('.', '_')}-${step}`
}

/**
 * @param {Object} config
 * @param {string} config.eventName
 * @param {Array}  config.transitions
 * @param {number} config.step
 * @param {number} config.lastStep
 * @param {string} config.initialStateName
 * @return {Object} Object declaration for a state node.
 */
function createAsyncGuardNode({
  eventName,
  transition,
  step,
  lastStep,
  initialStateName,
  stateID,
  inGuardEvaluation,
}) {
  if (transition.cond === undefined) {
    return {
      entry: send((ctx, evt) => evt.originalEvent ?? evt),
      on: {
        [eventName]: {
          ...transition,
          target: transition.target ?? initialStateName,
        },
      },
    }
  }

  const guardName =
    typeof transition.cond === 'string' ? transition.cond : transition.cond.name
  const guardID = `${guardName}[${stateID}.${eventName}.${step}]`
  const actorID = `asyncGuardActor#${guardID}`

  return {
    // this is for transitioning on success with the original event
    on: {
      [eventName]: {
        ...transition,
        cond: undefined,
        in: inGuardEvaluation.trailing ? transition.in : undefined,
        target: transition.target ?? initialStateName,
      },
      [`done.async-guard.${guardID}`]: [
        {
          cond: isResultTrue,
          in: inGuardEvaluation.trailing ? transition.in : undefined,
          actions: send((context, evt) => evt.originalEvent),
        },
        step !== lastStep
          ? {
              target: makeStateName(eventName, step + 1),
            }
          : {
              target: initialStateName,
            },
      ],

      [`error.async-guard.${guardID}`]: {
        // we send this simplified event to allow users to declare error transitions for
        // specific guards
        actions: send(`error.async-guard.${guardName}`),
      },
    },

    entry: assign((context, evt, { state }) => {
      let asyncGuard =
        typeof transition.cond === 'function'
          ? transition.cond
          : state.configuration.find((x) => x.order === 0).options.guards[
              transition.cond
            ]

      if (
        transition.in != null &&
        inGuardEvaluation.leading &&
        !state.matches(transition.in.replace(/^#[^.]*\./, ''))
      ) {
        // we will not execute the async guard if the "in" guard is not satisfied
        // instead we will resolve with a false → evaluate to the next case
        asyncGuard = async () => false
      }

      if (typeof asyncGuard !== 'function') {
        throw new Error(
          `The transition guard is not a function and no such guard was found among configured machine guards. Check transitions for event ${eventName}`
        )
      }
      return {
        [actorID]: spawn(withOriginalEvent(asyncGuard, context, evt, guardID), {
          name: actorID,
        }),
      }
    }),
    exit: stop(actorID),
  }
}

/**
 * @param {Object} transition Object declaration for a state transition.
 * @return {boolean}
 */
function transitionHasGuard(transition) {
  return transition.cond !== undefined
}

/**
 * @param {string} event
 * @return {boolean}
 */
function isAsyngGuardErrorEvent(event) {
  return event.match(/^error\.async-guard\./)
}

/**
 * Helper for creating state declarations with asynchronous guards.
 * Example:

    SomeState: withAsyncGuards({
      id: 'someState', // state node ID is mandatory
      on: {
        DONE: '#root.Done',
        PING: {
          actions: () => console.log('PING received'),
        },
        FOO: [
          {
            cond: isSmall, // async function reference
            target: '#root.Small', // must use absolute targets
          },
          {
            cond: 'isLarge', // string reference to async function in the machine config
            target: '#root.Large',
            actions: () => console.log('isLarge success'),
          },
          {
            cond: async (c, e) => e.value === 50, // inlined async function
            target: '#root.Middle',
          },
          {
            target: 'Default',  // default transition is optional
          }
        ],
        // rejected guard promises can be handled like this
        'error.async-guard.isSmall': {
          actions: (c, e) => console.log('!!! error in guard isSmall', e)
        },
        'error.async-guard.isLarge': {
          actions: (c, e) => console.log('!!! error in guard isLarge', e)
        }
      },

      // other regular state props are supported
      entry: (c, e) => console.log('» SomeState'),
      exit: (c, e) => console.log('« SomeState', e),
      invoke: {
        src: async () => {}
      },
    }),
 *
 * @param {Object} config XState state declaration.
 * @param {Object} [options] An optional second argument may contain options:
 * @param {Object} [options.inGuardEvaluation] An object to configure how "in" guards are evaluated in relation to
 *   async guards:
 *   (bool) leading=true    If true, in guards will be evaluated first, before the async guards are evaluated. Async guard will be
 *                          evaluated only if the in guard is satisfied. Default is true.
 *   (bool) trailing=false  If true, in guards will be evaluated after async guards have been successfully resolved. If the in
 *                          guard is not satisfied in this moment, the transition will not be taken (even though the async guard is satisfied).
 * @param {Object} Modified state declartion which waits for resolution of asynchronous guards.
 */
export function withAsyncGuards(config, options) {
  const defaultOptions = {
    inGuardEvaluation: {
      leading: true,
      trailing: false,
    },
  }
  options = {
    ...defaultOptions,
    ...options,
    inGuardEvaluation: {
      ...defaultOptions.inGuardEvaluation,
      ...options?.inGuardEvaluation,
    },
  }

  const { on, id, ...rest } = config
  if (on === undefined) {
    throw new Error(
      'Missing "on" property. Transition declaration is mandatory!'
    )
  }
  if (id == null) {
    throw new Error(
      'Missing "id" property. State node ID is mandatory when using async guards!'
    )
  }

  const initialStateName = 'async-guards-init'
  const allEventsTransitions = Object.entries(on)
  const globalTransitions = {}

  const states = allEventsTransitions.reduce(
    (acc, [eventName, transitions]) => {
      if (isAsyngGuardErrorEvent(eventName)) {
        globalTransitions[eventName] = transitions
        return acc
      }
      if (
        typeof transitions === 'string' ||
        (!Array.isArray(transitions) && !transitionHasGuard(transitions)) ||
        (Array.isArray(transitions) && !transitionHasGuard(transitions[0]))
      ) {
        acc[initialStateName].on[eventName] = transitions
        return acc
      }
      acc[initialStateName].on[eventName] = makeStateName(eventName, 0)

      if (!Array.isArray(transitions)) {
        transitions = [transitions]
      }
      transitions.forEach((transition, step) => {
        acc[makeStateName(eventName, step)] = createAsyncGuardNode({
          eventName,
          transition,
          step,
          lastStep: transitions.length - 1,
          initialStateName,
          stateID: id,
          inGuardEvaluation: options.inGuardEvaluation,
        })
      })
      return acc
    },
    {
      [initialStateName]: {
        on: {},
      },
    }
  )

  return {
    ...rest,
    id,
    initial: initialStateName,
    states,
    on: globalTransitions,
  }
}
