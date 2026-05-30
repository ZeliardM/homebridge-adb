const adb = require('adbkit');
const CommandQueue = require('./command-queue');
const { sendMagicPacket } = require('./wol');

const DEFAULT_TIMEOUT = 3000;
const DEFAULT_WAKE_RETRY_WINDOW = 25000;
const DEFAULT_WAKE_DELAY = 700;
const DEFAULT_WAKE_RETRY_DELAY = 2000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class AdbManager {
  constructor(log, config) {
    this.log = log;
    this.config = config || {};
    this.ip = this.config.ip;
    this.adbport = Number.isFinite(this.config.adbport) ? this.config.adbport : 5555;
    this.serial = `${this.ip}:${this.adbport}`;
    this.timeout = Math.max(DEFAULT_TIMEOUT, Number(this.config.timeout) || DEFAULT_TIMEOUT);
    this.stateAdbCommand = this.config.stateAdbCommand;
    this.stateAdbOutputAwake = this.config.stateAdbOutputAwake;
    this.poweron = this.config.poweron || 'WAKE';
    this.poweroff = this.config.poweroff || 'KEYCODE_SLEEP';
    this.fastPowerOff = !!this.config.fastpoweroff;
    this.mac = this.config.mac;
    this.queue = new CommandQueue();
    this.client = adb.createClient();
  }

  async connect() {
    try {
      const id = await this.client.connect(this.ip, this.adbport);
      return { result: true, message: String(id) };
    } catch (error) {
      return { result: false, message: error && error.message ? error.message : String(error) };
    }
  }

  async shell(command, timeoutMs = this.timeout) {
    if (!command || typeof command !== 'string') {
      return { result: false, message: 'No shell command provided' };
    }

    let stream;
    try {
      const shellPromise = this.client.shell(this.serial, command).then(result => {
        stream = result;
        return result;
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`ADB Shell timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      await Promise.race([shellPromise, timeoutPromise]);

      const outputBuffer = await adb.util.readAll(stream);
      const outputText = outputBuffer.toString().trim();

      return {
        result: true,
        message: outputText,
        stdout: outputText,
        stderr: '',
      };
    } catch (error) {
      if (stream && typeof stream.destroy === 'function') {
        stream.destroy();
      }

      return {
        result: false,
        message: error && error.message ? String(error.message) : String(error),
        stdout: '',
        stderr: '',
      };
    }
  }

  async keepalive() {
    const connectResult = await this.connect();
    if (!connectResult.result) return connectResult;

    return await this.shell('echo adb-shell-works');
  }

  async wake() {
    const deadline = Date.now() + DEFAULT_WAKE_RETRY_WINDOW;
    let sentMagic = false;
    let lastError = 'Wake flow failed';

    while (Date.now() < deadline) {
      if (this.mac && !sentMagic) {
        try {
          await sendMagicPacket(this.mac, this.ip, { port: 9, repeat: 3, delay: 1000 });
          sentMagic = true;
        } catch (error) {
          lastError = error.message || String(error);
          break;
        }
      }

      const connectResult = await this.connect();
      if (!connectResult.result) {
        lastError = connectResult.message || lastError;
        await sleep(DEFAULT_WAKE_RETRY_DELAY);
        continue;
      }

      const verifyResult = await this.shell('echo adb-shell-works');
      if (!verifyResult.result) {
        lastError = verifyResult.message || lastError;
        await sleep(DEFAULT_WAKE_RETRY_DELAY);
        continue;
      }

      const keyUp = await this.shell('input keyevent 224');
      if (!keyUp.result) {
        lastError = keyUp.message || lastError;
      }

      await sleep(DEFAULT_WAKE_DELAY);
      const keyHome = await this.shell('input keyevent 3');
      if (!keyHome.result) {
        lastError = keyHome.message || lastError;
      }

      return { result: true, message: 'Wake flow completed' };
    }

    return { result: false, message: lastError };
  }

  async powerOn() {
    const normalized = String(this.poweron || 'WAKE').trim();
    if (normalized.toUpperCase() === 'WAKE') {
      return await this.wake();
    }

    if (normalized.toUpperCase().startsWith('KEYCODE_')) {
      return await this.sendKeycode(normalized);
    }

    return { result: false, message: 'Unsupported poweron value' };
  }

  async powerOff() {
    const normalized = String(this.poweroff || 'KEYCODE_SLEEP').trim();
    if (this.fastPowerOff && normalized.toUpperCase() === 'KEYCODE_SLEEP') {
      return await this.sendKeycode(normalized);
    }

    if (normalized.toUpperCase().startsWith('KEYCODE_')) {
      return await this.sendKeycode(normalized);
    }

    return { result: false, message: 'Unsupported poweroff value' };
  }

  async sendKeycode(keycode) {
    const normalized = String(keycode || '').trim();
    if (!normalized) return { result: false, message: 'No keycode provided' };
    return await this.shell(`input keyevent ${normalized}`);
  }

  async launchApp(commandOrId) {
    const trimmed = String(commandOrId || '').trim();
    return await this.adb.launchApp(trimmed);
  }

  async getModelInfo() {
    const output = await this.shell('getprop ro.product.model && echo __SEP__ && getprop ro.product.manufacturer && echo __SEP__ && getprop ro.serialno');
    if (!output.result) {
      return {
        model: 'Android TV',
        manufacturer: 'Homebridge ADB',
        serial: this.serial,
      };
    }

    const parts = output.stdout.split('__SEP__').map(part => part.trim());
    return {
      model: parts[0] || 'Android TV',
      manufacturer: parts[1] || 'Homebridge ADB',
      serial: parts[2] || this.serial,
    };
  }

  async detectPowerState() {
    if (this.stateAdbCommand) {
      const output = await this.shell(this.stateAdbCommand);
      if (!output.result) return { result: false, awake: false, message: output.message };
      const awake = this.stateAdbOutputAwake
        ? output.stdout.includes(this.stateAdbOutputAwake)
        : output.stdout.toLowerCase().includes('awake');
      return { result: true, awake, message: output.stdout };
    }

    const output = await this.shell('dumpsys power');
    if (!output.result) return { result: false, awake: false, message: output.message };

    const text = `${output.stdout} ${output.stderr}`;
    const wakefulnessMatch = /mWakefulness=(Awake|Asleep|Dozing|Unknown)/i.exec(text);
    if (wakefulnessMatch) {
      return { result: true, awake: wakefulnessMatch[1].toLowerCase() === 'awake', message: text };
    }

    const displayOn = /Display Power.*state=(ON)/i.test(text);
    if (displayOn) {
      return { result: true, awake: true, message: text };
    }

    const holdDisplay = /mHoldingDisplaySuspendBlocker.*true/i.test(text);
    if (holdDisplay) {
      return { result: true, awake: true, message: text };
    }

    const fallbackAwake = /awake/i.test(text) && !/asleep/i.test(text);
    return { result: true, awake: fallbackAwake, message: text };
  }

  async detectCurrentAppId() {
    const output = await this.shell('dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp" || dumpsys activity activities | grep -E "mResumedActivity|mFocusedActivity"');
    if (!output.result) return { result: false, appId: null };

    const text = output.stdout;
    const packageMatch = /([a-zA-Z0-9_\.]+)\//.exec(text);
    if (packageMatch) {
      return { result: true, appId: packageMatch[1] };
    }

    return { result: false, appId: null };
  }

  async detectPlayback() {
    const output = await this.shell('dumpsys media_session');
    if (!output.result) return { result: false, playing: false };

    const text = output.stdout;
    const playing = /state\s*=\s*(3|PLAYING)/i.test(text) && !/state\s*=\s*(2|PAUSED)/i.test(text);
    return { result: true, playing };
  }

  async enqueue(task) {
    return await this.queue.enqueue(task);
  }

  stop() {
    this.queue.stop();
  }
}

module.exports = AdbManager;
