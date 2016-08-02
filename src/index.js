import assert from 'assert'
import createDebugger from 'debug'
import { EventEmitter } from 'events'
import _ from 'highland'

// Custom error class.
import GDBError from './error.js'
// Parser for the GDB/MI output syntax.
import { parse as parseMI } from './parsers/gdbmi.pegjs'
// Parser for the output of `info` GDB command.
import { parse as parseInfo } from './parsers/info.pegjs'
// Base class for custom GDB commands.
import baseCommand from './scripts/base.py'
// Command that puts CLI output to a single console record.
import concatCommand from './scripts/concat.py'
// Command that lists all variables in the current context.
import contextCommand from './scripts/context.py'
// Command that searches source files using regex.
import searchCommand from './scripts/search.py'

// Default prefix for results of CLI commands.
const TOKEN = 'GDBJS^'

let debugCLIResluts = createDebugger('gdb-js:results:cli')
let debugMIResluts = createDebugger('gdb-js:results:mi')
let debugOutput = createDebugger('gdb-js:output')
let debugInput = createDebugger('gdb-js:input')

/**
 * Converts string to integer.
 *
 * @param {string} str The input string.
 * @returns {number} The output integer.
 *
 * @ignore
 */
function toInt (str) {
  return parseInt(str, 10)
}

/**
 * Escapes symbols in python code so that we can send it using inline mode.
 *
 * @param {string} script The Python script.
 * @returns {string} The escaped python script.
 *
 * @ignore
 */
function escape (script) {
  return script.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/"/g, '\\"')
}

/**
 * A variable representation.
 *
 * @typedef {object} Variable
 * @property {string} name The name of the variable.
 * @property {string} type The type of the variable.
 * @property {string} scope The scope of the variable.
 * @property {string} value The value of the variable.
 */

/**
 * A thread representation.
 *
 * @typedef {object} Thread
 * @property {number} id The thread ID.
 * @property {ThreadGroup} [group] The thread group.
 * @property {string} [stopped] The thread status (e.g. `stopped`).
 * @property {Frame} [frame] The frame where thread is currently on.
 */

/**
 * A thread-group representation.
 *
 * @typedef {object} ThreadGroup
 * @property {string} id The thread-group ID.
 * @property {string} [executable] The executable of target.
 * @property {number} [pid] The PID of the thread-group.
 */

/**
 * A frame representation.
 *
 * @typedef {object} Frame
 * @property {string} file The full path to a file.
 * @property {number} line The line number.
 * @property {number} [level] The level of stack frame.
 */

/**
 * A breakpoint representation.
 *
 * @typedef {object} Breakpoint
 * @property {number} id Breakpoint ID.
 * @property {string} [file] The full path to a file in which breakpoint appears.
 * @property {number} [line] The line number at which the breakpoint appears.
 * @property {string} [func] The function in which the breakpoint appears.
 * @property {number} [times] The number of times the breakpoint has been hit.
 * @property {Thread} [thread] The thread for thread-specific breakpoints.
 */

/**
 * Class representing a GDB abstraction.
 *
 * @extends EventEmitter
 * @public
 */
class GDB extends EventEmitter {
  /**
   * Create a GDB wrapper.
   *
   * @param {object} childProcess A Node.js child process or just an
   *   object with `stdin`, `stdout`, `stderr` properties that are Node.js streams.
   *   If you're using GDB all-stop mode, then it should also have implementation of
   *   `kill` method that is able to send signals (such as `SIGINT`).
   * @param {object} [options] An options object.
   * @param {string} [options.token="GDBJS^"] Prefix for the results of CLI commands.
   *   Please, see {@link GDB#execCLI|execCLI} for more information.
   */
  constructor (childProcess, options) {
    super()

    this.options = Object.assign({}, options, { token: TOKEN })

    this._process = childProcess
    this._token = this.options.token
    /**
     * The main queue of commands sent to GDB.
     *
     * @ignore
     */
    this._queue = _()

    let stream = _(this._process.stdout)
      .map((chunk) => chunk.toString())
      .splitBy(/\r\n|\n/)
      .tap(debugOutput)
      .map(parseMI)

    // Basically, we're just branching our stream to the messages that should
    // be emitted and the results which we then zip with the sent commands.
    // Results can be either result records or console records with the specified prefix.

    // Emitting raw stream records.

    /**
     * Raw output of GDB/MI notify records.
     * Contains supplementary information that the client should handle.
     * Please, see
     * {@link https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-Async-Records.html|the official GDB/MI documentation}.
     *
     * @event GDB#notify
     * @type {object}
     * @property {string} state The class of the notify record (e.g. `thread-created`).
     * @property {object} data JSON representation of GDB/MI message.
     */

    /**
     * Raw output of GDB/MI status records.
     * Contains on-going status information about the progress of a slow operation.
     *
     * @event GDB#status
     * @type {object}
     * @property {string} state The class of the status record.
     * @property {object} data JSON representation of GDB/MI message.
     */

    /**
     * Raw output of GDB/MI exec records.
     * Contains asynchronous state change on the target.
     *
     * @event GDB#exec
     * @type {object}
     * @property {string} state The class of the exec record (e.g. `stopped`).
     * @property {object} data JSON representation of GDB/MI message.
     */
    stream.fork()
      .filter((msg) => ['console', 'target', 'log'].includes(msg.type))
      .each((msg) => { this.emit(msg.type, msg.data) })

    // Emitting raw async records.

    /**
     * Raw output of GDB/MI console records.
     * The console output stream contains text that should be displayed in the CLI console window.
     *
     * @event GDB#console
     * @type {string}
     */

    /**
     * Raw output of GDB/MI log records.
     * The log stream contains debugging messages being produced by gdb's internals.
     *
     * @event GDB#log
     * @type {string}
     */

    /**
     * Raw output of GDB/MI target records.
     * The target output stream contains any textual output from the running target.
     * Please, note that it's currently impossible
     * to distinguish the target and the MI output correctly due to a bug in GDB/MI. Thus,
     * it's recommended to use `--tty` option with your GDB process.
     *
     * @event GDB#target
     * @type {string}
     */
    stream.fork()
      .filter((msg) => ['exec', 'notify', 'status'].includes(msg.type))
      .each((msg) => { this.emit(msg.type, { state: msg.state, data: msg.data }) })

    // Emitting defined events.

    /**
     * This event is emitted when target or one of its threads has stopped due to some reason.
     * Note that `thread` property indicates the thread that caused the stop. In an all-stop mode
     * all threads will be stopped.
     *
     * @event GDB#stopped
     * @type {object}
     * @property {string} reason The reason of why target has stopped (see
     *   {@link https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-Async-Records.html|the official GDB/MI documentation}) for more information.
     * @property {Thread} [thread] The thread that caused the stop.
     * @property {Breakpoint} [breakpoint] Breakpoint is provided if the reason is
     *   `breakpoint-hit`.
     */
    stream.fork()
      .filter((msg) => msg.type === 'exec' && msg.state === 'stopped')
      .each((msg) => {
        let { data } = msg
        let thread = data['thread-id']
        let event = { reason: data.reason }
        if (thread) {
          event.thread = {
            id: toInt(thread),
            frame: {
              file: data.frame.fullname,
              line: toInt(data.frame.line)
            }
          }
        }
        if (data.reason === 'breakpoint-hit') {
          event.breakpoint = {
            id: toInt(data.bkptno)
          }
        }
        this.emit('stopped', event)
      })

    /**
     * This event is emitted when target changes state to running.
     *
     * @event GDB#running
     * @type {object}
     * @property {Thread} [thread] The thread that has changed its state.
     *   If it's not provided, all threads have changed their states.
     */
    stream.fork()
      .filter((msg) => msg.type === 'exec' && msg.state === 'running')
      .each((msg) => {
        let { data } = msg
        let event = {}
        if (data['thread-id'] !== 'all') {
          event.thread = {
            id: toInt(data['thread-id'])
          }
        }
        this.emit('running', event)
      })

    /**
     * This event is emitted when new thread spawns.
     *
     * @event GDB#thread-created
     * @type {Thread}
     */

    /**
     * This event is emitted when thread exits.
     *
     * @event GDB#thread-exited
     * @type {Thread}
     */
    stream.fork()
      .filter((msg) => msg.type === 'notify' &&
        ['thread-created', 'thread-exited'].includes(msg.state))
      .each((msg) => {
        let { state, data } = msg
        this.emit(state, {
          id: toInt(data.id),
          group: {
            id: data['group-id']
          }
        })
      })

    // Here, the stream should NOT be forked, but observed instead!
    // It's important, because zipping streams that are forked from
    // the same source may cause blocking.
    let cliOutput = stream.observe()
      // We consider as the result of CLI operation
      // only those console records that starts with our token.
      .filter((msg) => msg.type === 'console' && msg.data.startsWith(this._token))
      .map((msg) => msg.data.slice(this._token.length))
      .tap(debugCLIResluts)

    let results = stream.fork()
      .filter((msg) => msg.type === 'result')
      .zip(this._queue)
      .map((msg) => Object.assign({}, msg[0], msg[1]))

    results.fork()
      .filter((msg) => msg.state === 'error')
      .each((msg) => {
        let { data, cmd, reject } = msg
        let text = `Error while executing "${cmd}". ${data.msg}`
        let err = new GDBError(cmd, text, toInt(data.code))
        reject(err)
      })

    let success = results.fork()
      .filter((msg) => msg.state !== 'error')

    success.fork()
      .filter((msg) => msg.interpreter === 'mi')
      .tap((msg) => debugMIResluts(msg.data))
      .each((msg) => { msg.resolve(msg.data) })

    success.fork()
      .filter((msg) => msg.interpreter === 'cli')
      .zip(cliOutput)
      .each((msg) => { msg[0].resolve(msg[1]) })
  }

  /**
   * Get the child process object.
   *
   * @type {object}
   * @readonly
   */
  get process () {
    return this._process
  }

  /**
   * Extend GDB CLI interface with some useful commands that are
   * necessary for executing some methods of this GDB wrapper
   * (e.g. {@link GDB#context|context}, {@link GDB#execCLI|execCLI}).
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async init () {
    let commands = [baseCommand, concatCommand, contextCommand, searchCommand]
    for (let c of commands) {
      await this.execMI(`-interpreter-exec console "python\\n${escape(c)}"`)
    }
  }

  /**
   * Set internal GDB variable.
   *
   * @param {string} param The name of a GDB variable.
   * @param {string} value The value of a GDB variable.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async set (param, value) {
    await this.execMI(`-gdb-set ${param} ${value}`)
  }

  /**
   * Enable the `detach-on-fork` option which will automatically
   * attach GDB to any of forked processes. Please, note that it makes
   * sense only for systems that support `fork` and `vfork` calls.
   * It won't work for Windows, for example.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async attachOnFork () {
    await this.set('detach-on-fork', 'off')
  }

  /**
   * Enable async and non-stop modes in GDB. This mode is *highly* recommended!
   * Also, it changes the behaviour of the {@link GDB#interrupt|interrupt} method.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async enableAsync () {
    try {
      await this.set('mi-async', 'on')
    } catch (e) {
      // For gdb <= 7.7 (which not support `mi-async`).
      await this.set('target-async', 'on')
    }
    await this.set('non-stop', 'on')
    this._async = true
  }

  /**
   * Attach a new target (inferior) to GDB.
   *
   * @param {number} pid The process id.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async attach (pid) {
    await this.execMI('-target-attach ' + pid)
  }

  /**
   * Detache a target (inferior) from GDB.
   *
   * @param {number} pid The process id.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async detach (pid) {
    await this.execMI('-target-detach ' + pid)
  }

  /**
   * Interrupt the target. In all-stop mode and in non-stop mode without arguments
   * it interrupts all threads. In non-stop mode it can interrupt only specific thread or
   * a thread group.
   *
   * @param {Thread|ThreadGroup} [thread] The thread or the thread-group to interrupt.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async interrupt (thread) {
    if (!this._async) {
      this._process.kill('SIGINT')
    } else {
      let id = thread ? thread.id : null
      let options = typeof id === 'number'
        ? '--thread ' + id : id ? '--thread-group ' + id : '--all'
      await this.execMI('-exec-interrupt ' + options)
    }
  }

  /**
   * Get the information about all the threads or about specific thread.
   *
   * @param {Thread} [thread] The thread about which the information is needed.
   *   If this parameter is absent, then information about all threads is returned.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<Thread[]|Thread>} A promise that resolves with an array of threads
   *   or a single thread.
   */
  async threads (thread) {
    let res = await this.execMI('-thread-info ' + (thread ? thread.id : ''))
    let threads = res.threads.map((t) => {
      let thread = {
        id: toInt(t.id),
        state: t.state
      }
      if (t.frame) {
        thread.frame = {
          file: t.frame.fullname,
          line: toInt(t.frame.line),
          level: toInt(t.frame.level)
        }
      }
      return thread
    })

    return thread ? threads[0] : threads
  }

  /**
   * Get thread groups.
   *
   * @param {boolean} all Display all available thread groups or not.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<ThreadGroup[]>} A promise that resolves with an array thread groups.
   */
  async threadGroups (all) {
    let options = all ? '--available' : ''
    let { groups } = await this.execMI('-list-thread-groups ' + options)
    return groups.map((g) => ({
      id: g.id,
      pid: toInt(g.pid),
      executable: g.executable
    }))
  }

  /**
   * Insert a breakpoint at the specified position.
   *
   * @param {string} file The full name or just a file name.
   * @param {number|string} pos The function name or a line number.
   * @param {Thread} [thread] The thread where breakpoint should be set.
   *   If this field is absent, breakpoint applies to all threads.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<Breakpoint>} A promise that resolves with a breakpoint.
   */
  async addBreak (file, pos, thread) {
    let opt = thread ? '-p ' + thread : ''
    let { bkpt } = await this.execMI(`-break-insert ${opt} ${file}:${pos}`)
    return {
      id: toInt(bkpt.number),
      file: bkpt.fullname,
      line: toInt(bkpt.line),
      func: bkpt.func,
      thread
    }
  }

  /**
   * Removes a specific breakpoint.
   *
   * @param {Breakpoint} [bp] The breakpoint.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async removeBreak (bp) {
    await this.execMI('-break-delete ' + bp.id)
  }

  /**
   * Step in.
   *
   * @param {Thread} [thread] The thread where the stepping should be done.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async stepIn (thread) {
    await this.execMI('-exec-step', thread)
  }

  /**
   * Step out.
   *
   * @param {Thread} [thread] The thread where the stepping should be done.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async stepOut (thread) {
    await this.execMI('-exec-finish', thread)
  }

  /**
   * Execute to the next line.
   *
   * @param {Thread} [thread] The thread where the stepping should be done.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async next (thread) {
    await this.execMI('-exec-next', thread)
  }

  /**
   * Run the target.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async run () {
    await this.execMI('-exec-run')
  }

  /**
   * Continue execution.
   *
   * @param {Thread} [thread] The thread that should be continued.
   *   If this parameter is absent, all threads are continued.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async proceed (thread) {
    await thread ? this.execMI('-exec-continue', thread)
      : this.execMI('-exec-continue --all')
  }

  /**
   * List all variables in the current context (i.e. all global, static, local
   * variables in the current file).
   *
   * @param {Thread} [thread] The thread from which the context should be taken.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<Variable[]>} A promise that resolves with an array of variables.
   */
  async context (thread) {
    let res = await this.execCLI('gdbjs-context', thread)
    return JSON.parse(res)
  }

  /**
   * List all global variables. It uses the symbol table to achieve this.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<Variable[]>} A promise that resolves with an array of variables.
   */
  async globals () {
    if (!this._globals) {
      // Getting all globals is currently only possible
      // through parsing the symbol table. Symbol table is
      // exported to Python only partially, thus we need
      // to parse it manually.
      let res = await this.execCLI('info variables')
      this._globals = parseInfo(res)
    }

    let res = []

    for (let v of this._globals) {
      // TODO: instead of making multiple requests
      // it's better to do it with a single python function
      let value = await this.evaluate(v.name)
      res.push(Object.assign({}, v, { value }))
    }

    return res
  }

  /**
   * Get the callstack.
   *
   * @param {Thread} [thread] The thread from which the callstack should be taken.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<Frame[]>} A promise that resolves with an array of frames.
   */
  async callstack (thread) {
    let { stack } = await this.execMI('-stack-list-frames', thread)
    return stack.map((f) => ({
      file: f.value.fullname,
      line: toInt(f.value.line),
      level: toInt(f.value.level)
    }))
  }

  /**
   * Get list of source files or a subset of source files that match
   * the regular expression. Please, note that it doesn't return sources.
   *
   * @example
   * let headers = await gdb.sourceFiles('\.h$')
   *
   * @param {string} [pattern] The regular expression (see
   * {@link https://docs.python.org/2/library/re.html|Python regex syntax}).
   * This option is useful when the project has a lot of files so that
   * it's not desirable to send them all in one chunk along the wire.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<string[]>} A promise that resolves with an array of source files.
   */
  async sourceFiles (pattern) {
    if (pattern) {
      let files = await this.execCLI('gdbjs-search ' + pattern)
      return JSON.parse(files)
    } else {
      let { files } = await this.execMI('-file-list-exec-source-files')
      return files.map((f) => f.fullname)
    }
  }

  /**
   * Evaluate a GDB expression.
   *
   * @param {string} expr The expression to evaluate.
   * @param {Thread} [thread] The thread where the expression should be evaluated.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<string>} A promise that resolves with the result of expression.
   */
  async evaluate (expr, thread) {
    let { value } = await this.execMI('-data-evaluate-expression ' + expr, thread)
    return value
  }

  /**
   * Exit GDB.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise} A promise that resolves/rejects after completion of a GDB/MI command.
   */
  async exit () {
    await this.execMI('-gdb-exit')
  }

  /**
   * Execute a custom python script. Internally it calls {@link GDB#execCLI|execCLI}
   * method. Thus, everything about it applies to this method as well. So, if your
   * python script is asynchronous and you're interested in its output, you should
   * listen to {@link GDB#event:console|raw console output}. Here's the example below.
   *
   * By the way, with this method you can define your own CLI commands and then call
   * them via {@link GDB#execCLI|execCLI} method. For more examples, see `scripts` folder
   * in the main repository and read
   * {@link https://sourceware.org/gdb/current/onlinedocs/gdb/Python-API.html|official GDB Python API}
   * and {@link https://sourceware.org/gdb/wiki/PythonGdbTutorial|PythonGdbTutorial}.
   *
   * @example
   * let script = `
   * import gdb
   * import threading
   *
   *
   * def foo():
   *     sys.stdout.write('bar')
   *     sys.stdout.flush()
   *
   * timer = threading.Timer(5, foo)
   * timer.start()
   * `
   * gdb.on('console', (str) => {
   *   if (str === 'bar') console.log('yep')
   * })
   * await gdb.execPy(script)
   *
   * @param {string} src The python script.
   * @param {Thread} [thread] The thread where the script should be executed.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<string>} A promise that resolves with the output of
   *   python script execution.
   */
  async execPy (src, thread) {
    assert(src, 'You must provide a script.')
    return await this.execCLI(`python\\n${escape(src)}`, thread)
  }

  /**
   * Execute a CLI command. Internally it calls `gdbjs-concat` CLI command that is
   * defined in the {@link GDB#init|init} method. This command executes a given CLI
   * command and puts its output to a single console record with a prepended prefix.
   * Prepended prefix is the token that you can pass to a constructor of this class
   * (defaults to `"GDBJS^"`). This is how GDB-JS is able to distinguish responses
   * to your commands and random GDB/MI console records. Note that it will return
   * only synchronous responses. If a CLI command is asynchronous and you are interested
   * in its output, you should listen to {@link GDB#event:console|raw console output}.
   *
   * @param {string} cmd The CLI command.
   * @param {Thread} [thread] The thread where the command should be executed.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<string>} A promise that resolves with the result of command execution.
   */
  async execCLI (cmd, thread) {
    let res = await this._exec(thread ? `thread apply ${thread.id} ${cmd}` : cmd, 'cli')
    // `thread apply` command may prepend two extraneous lines to the output.
    return thread ? res.split('\n').slice(2).join('\n') : res
  }

  /**
   * Execute a MI command.
   *
   * @param {string} cmd The MI command.
   * @param {Thread} [thread] The thread where the command should be executed.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<object>} A promise that resolves with the JSON representation
   *   of the result of command execution.
   */
  async execMI (cmd, thread) {
    let parts = cmd.split(/ (.+)/)
    let options = parts.length > 1 ? parts[1] : ''
    // Most of GDB/MI commands support `--thread` option.
    // However, in order to work it should be the first option.
    return await this._exec(thread
      ? `${parts[0]} --thread ${thread.id} ${options}` : cmd, 'mi')
  }

  /**
   * Internal method that executes a MI command and add it to the queue where it
   * waits for the results of execution.
   *
   * @param {string} cmd The command.
   * @param {string} interpreter The interpreter that should execute the command.
   *
   * @throws {GDBError} Internal GDB errors that arise in the MI interface.
   * @returns {Promise<object>} A promise that resolves with the JSON representation
   *   of the result of command execution.
   *
   * @ignore
   */
  async _exec (cmd, interpreter) {
    debugInput(cmd)
    // All CLI commands are actually executed within MI interface.
    // And all of them are executed with the support of `gdbjs-concat` command that is defined
    // in the `init` method. `gdbjs-concat` makes it possible to view whole output
    // of a CLI command in the single console record.
    cmd = interpreter === 'cli'
      ? `-interpreter-exec console "gdbjs-concat ${this._token} ${cmd}"` : cmd
    this._process.stdin.write(cmd + '\n', { binary: true })
    return await new Promise((resolve, reject) => {
      this._queue.write({ cmd, interpreter, resolve, reject })
    })
  }
}

// XXX: `export default` won't work here
// the same way due to messed up semantics.
// It'll export `{ default: ... }` object.
module.exports = GDB
