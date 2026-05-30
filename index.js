const AdbManager = require('./lib/adb-manager');
let Service, Characteristic;

const PLUGIN_NAME = 'homebridge-adb';
const PLATFORM_NAME = 'HomebridgeADB';

const YES = true;
const NO = false;
const EMPTY = '';
const OTHER_APP_ID = 'other';
const HOME_APP_ID = 'home';

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ADBPluginPlatform, true);
};

class ADBPlugin {
  constructor(log, config, api) {
    if (!config) return;

    this.log = log;
    this.api = api;
    this.config = config;
    this.name = this.config.name || 'Android Accessory';
    this.ip = this.config.ip;

    if (!this.ip) {
      this.log.error(`Please provide IP for accessory: ${this.name}`);
      return;
    }

    this.adbport = Number.isFinite(this.config.adbport) ? this.config.adbport : 5555;
    this.mac = this.config.mac || '';
    this.timeout = Math.max(1000, Number(this.config.timeout) || 3000);
    this.interval = Math.max(500, Number(this.config.interval) || 5000);
    this.debug = !!this.config.debug;
    this.connectOnStartup = !!this.config.connectonstartup;
    this.keepAdbAliveWhenSleeping = !!this.config.keepadbalivewhensleeping;
    this.keepAliveInterval = Math.max(10000, Number(this.config.keepaliveinterval) || 10000);
    this.connectionDebounceCount = Math.max(1, Number(this.config.connectiondebouncecount) || 2);
    this.suppressSleepingDisconnectLogs = this.config.suppresssleepingdisconnectlogs !== false;
    this.markAsleepWhenDisconnected = !!this.config.markasleepwhendisconnected;
    this.startupSettleDelay = Math.max(0, Number(this.config.startupsettledelay) || 250);
    this.powerSettleDelay = Math.max(0, Number(this.config.powersettledelay) || 12000);
    this.fastPowerOff = !!this.config.fastpoweroff;
    this.powerState = NO;
    this.powerOnChange = NO;
    this.powerSettlingUntil = 0;
    this.connectedState = NO;
    this.connectedCount = 0;
    this.disconnectedCount = 0;
    this.isShuttingDown = NO;

    this.input = Array.isArray(this.config.inputs) ? this.config.inputs.slice() : [];
    this.hidenumber = !!this.config.hidenumber;
    this.hideHome = !!this.config.hidehome;
    this.hideOther = !!this.config.hideother;
    if (!this.hideHome) this.input.unshift({ name: 'Home', id: HOME_APP_ID });
    if (!this.hideOther) this.input.push({ name: 'Other', id: OTHER_APP_ID });
    this.hiddenInputSlots = Math.max(0, Math.floor(Number(this.config.hiddeninputslots) || 0));
    this.inputSourceCount = Math.min(50, this.input.length + this.hiddenInputSlots);
    this.category = String(this.config.category || 'TELEVISION').toUpperCase();
    this.enableSpeaker = this.config.skipSpeaker ? NO : YES;
    this.enablePlaybackSensor = !!this.config.playbacksensor;
    this.isPlaying = NO;
    this.inputOnChange = NO;
    this.inputIndex = 0;
    this.currentAppID = HOME_APP_ID;

    this.stateAdbCommand = this.config.stateAdbCommand;
    this.stateAdbOutputAwake = this.config.stateAdbOutputAwake;

    this.adb = new AdbManager(this.log, {
      ip: this.ip,
      adbport: this.adbport,
      timeout: this.timeout,
      poweron: this.config.poweron,
      poweroff: this.config.poweroff,
      fastpoweroff: this.fastPowerOff,
      mac: this.mac,
      stateAdbCommand: this.stateAdbCommand,
      stateAdbOutputAwake: this.stateAdbOutputAwake,
    });

    const uuid = this.api.hap.uuid.generate(`homebridge:adb-plugin:${this.ip}:${this.name}`);
    const uuidos = this.api.hap.uuid.generate(`homebridge:adb-plugin:${this.ip}:${this.name}:PlaybackSensor`);
    const uuidsi = this.api.hap.uuid.generate(`homebridge:adb-plugin:${this.ip}:${this.name}:SwitchInputs`);

    this.accessory = new this.api.platformAccessory(this.name, uuid);
    if (this.enablePlaybackSensor) this.accessoryPlaybackSensor = new this.api.platformAccessory(`${this.name} Playback Sensor`, uuidos);
    this.switchInputs = new this.api.platformAccessory(`${this.name} Switch Inputs`, uuidsi);
    this.switchInputsArray = [];
    this.switchInputsService = this.switchInputs.addService(Service.Switch);

    switch (this.category) {
      case 'SPEAKER':
        this.accessory.category = this.api.hap.Categories.SPEAKER;
        break;
      case 'TV_STREAMING_STICK':
        this.accessory.category = this.api.hap.Categories.TV_STREAMING_STICK;
        break;
      case 'TV_SET_TOP_BOX':
        this.accessory.category = this.api.hap.Categories.TV_SET_TOP_BOX;
        break;
      case 'AUDIO_RECEIVER':
        this.accessory.category = this.api.hap.Categories.AUDIO_RECEIVER;
        break;
      case 'APPLE_TV':
        this.accessory.category = this.api.hap.Categories.APPLE_TV;
        break;
      default:
        this.accessory.category = this.api.hap.Categories.TELEVISION;
        break;
    }

    this.accessoryService = this.accessory.addService(Service.Television);
    this.accessoryInfo = this.accessory.getService(Service.AccessoryInformation);
    this.accessoryService.setCharacteristic(Characteristic.ConfiguredName, this.name);
    this.accessoryService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    if (this.api && typeof this.api.on === 'function') {
      this.api.on('shutdown', this.shutdown.bind(this));
    }

    this.displayInfo('Initializing');
    this.initialize().catch(error => {
      this.displayInfo('Initialization failed');
      if (error) this.displayDebug(error);
    });
  }

  async initialize() {
    if (this.connectOnStartup) {
      this.displayInfo('Startup connect - Starting');
      const output = await this.adb.enqueue(() => this.adb.connect());
      if (output && output.result) {
        this.displayInfo('Startup connect - Success');
      } else {
        this.displayInfo('Startup connect - Failed');
        this.displayDebug(output ? output.message : 'No output');
      }
      if (this.startupSettleDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, this.startupSettleDelay));
      }
    }

    await this.createAccessories();
    this.handleOnOff();
    this.handleInputs();
    this.handleVolume();
    this.handleRemoteControl();
    this.startPollLoop();
    this.startSleepingKeepAliveLoop();
  }

  async createAccessories() {
    const info = await this.adb.enqueue(() => this.adb.getModelInfo());
    this.createInputs();
    this.createSwitchInputs();
    this.createTV(info);
    this.createTVSpeakers();
    this.createPlaybackSensor(info);
    if (!info || !info.model) {
      this.log.error(`WARNING: Unrecognized accessory - "${this.name}". Check the IP address or ensure the device is awake.`);
    } else {
      this.displayInfo('Accessory initialized.');
    }
  }

  createInputs() {
    if (this.input.length <= 0) return;

    for (let i = 0; i < this.inputSourceCount; i += 1) {
      const input = this.input[i] || {};
      let type = Characteristic.InputSourceType.APPLICATION;
      let configured = Characteristic.IsConfigured.CONFIGURED;
      let targetVisibility = Characteristic.TargetVisibilityState.SHOWN;
      let currentVisibility = Characteristic.CurrentVisibilityState.SHOWN;
      let name = '';

      if (i === 0 && !this.hideHome) type = Characteristic.InputSourceType.HOME_SCREEN;
      else if (i === this.input.length - 1 && !this.hideOther) type = Characteristic.InputSourceType.OTHER;

      let humanNumber = i + 1;
      if (humanNumber < 10) humanNumber = `0${humanNumber}`;

      if (i >= this.input.length || !input.name || !input.id) {
        configured = Characteristic.IsConfigured.NOT_CONFIGURED;
        targetVisibility = Characteristic.TargetVisibilityState.HIDDEN;
        currentVisibility = Characteristic.CurrentVisibilityState.HIDDEN;
        name = `${humanNumber} Hidden Input`;
      } else {
        name = `${input.name}`;
        if (!this.hidenumber) name = `${humanNumber} ${name}`;
      }

      if (targetVisibility === Characteristic.TargetVisibilityState.SHOWN) {
        this.displayDebug(`Input: ${name}`);
      }

      const service = this.accessory.addService(Service.InputSource, `Input ${name}`, i);
      service
        .setCharacteristic(Characteristic.Identifier, i)
        .setCharacteristic(Characteristic.ConfiguredName, name)
        .setCharacteristic(Characteristic.InputSourceType, type)
        .setCharacteristic(Characteristic.TargetVisibilityState, targetVisibility)
        .setCharacteristic(Characteristic.CurrentVisibilityState, currentVisibility)
        .setCharacteristic(Characteristic.IsConfigured, configured);
      this.accessoryService.addLinkedService(service);

      if (configured === Characteristic.IsConfigured.CONFIGURED) {
        this.input[i].service = service;
      }
    }
  }

  createSwitchInputs() {
    if (this.input.length <= 0) return;

    this.switchInputs.currentId = this.currentAppID;
    this.switchInputs.add = service => {
      this.switchInputsArray.push(service);
    };
    this.switchInputs.turnOn = () => {
      this.switchInputsArray.forEach(accessory => {
        accessory.updateCharacteristic(Characteristic.On, accessory.id === this.switchInputs.currentId ? YES : NO);
      });
      this.displayDebug('Updating switches', this.switchInputs.currentId);
    };

    for (let i = 0; i < this.input.length; i += 1) {
      const input = this.input[i];
      const name = `${input.name}`;

      if (input.switch) {
        const service = this.accessory.addService(Service.Switch, name, i)
          .setCharacteristic(Characteristic.Name, name);
        service.id = input.id;
        this.handleSwitchInput(service);
        this.switchInputsService.addLinkedService(service);
        this.switchInputs.add(service);
        this.displayDebug(`Switch: ${name}`);
      }
    }
  }

  createTV(modelInfo) {
    this.accessoryInfo
      .setCharacteristic(Characteristic.Model, modelInfo.model || 'Android TV')
      .setCharacteristic(Characteristic.Manufacturer, modelInfo.manufacturer || 'Homebridge ADB')
      .setCharacteristic(Characteristic.SerialNumber, modelInfo.serial || this.ip);
    this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessory]);
    this.displayDebug('TV created');
  }

  createTVSpeakers() {
    if (this.enableSpeaker === NO) return;

    this.accessoryTVSpeakerService = this.accessory.addService(Service.TelevisionSpeaker);
    this.accessoryTVSpeakerService
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.RELATIVE);
    this.accessoryService.addLinkedService(this.accessoryTVSpeakerService);
    this.displayDebug('Speaker created');
  }

  createPlaybackSensor(modelInfo) {
    if (this.enablePlaybackSensor === NO) return;

    this.accessoryPlaybackSensor.category = this.api.hap.Categories.SENSOR;
    this.accessoryPlaybackSensorInfo = this.accessoryPlaybackSensor.getService(Service.AccessoryInformation);
    this.accessoryPlaybackSensorService = this.accessoryPlaybackSensor.addService(Service.MotionSensor);
    this.handleMediaAsSensor();

    this.accessoryPlaybackSensorInfo
      .setCharacteristic(Characteristic.Model, modelInfo.model || 'Android')
      .setCharacteristic(Characteristic.Manufacturer, modelInfo.manufacturer || 'Homebridge ADB')
      .setCharacteristic(Characteristic.SerialNumber, modelInfo.serial || this.ip);
    this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessoryPlaybackSensor]);
    this.displayDebug('Sensor created');
  }

  isPowerSettling() {
    return Date.now() < this.powerSettlingUntil;
  }

  startPollLoop() {
    this.displayDebug(`Starting poll loop every ${this.interval}ms`);
    this.pollTimer = null;
    this.scheduleNextPoll(0);
  }

  stopPollLoop() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  scheduleNextPoll(delay) {
    if (this.isShuttingDown) return;
    this.stopPollLoop();
    this.pollTimer = setTimeout(() => this.pollOnce(), delay);
  }

  async pollOnce() {
    if (this.isShuttingDown) return;
    if (this.adb.queue.isBusy) {
      this.displayDebug('Poll skipped because command queue is busy');
      this.scheduleNextPoll(this.interval);
      return;
    }

    await this.adb.enqueue(async () => {
      const connectResult = await this.adb.connect();
      this.updateConnectionState(connectResult.result);

      if (!connectResult.result) {
        if (this.markAsleepWhenDisconnected && this.powerState && this.disconnectedCount >= this.connectionDebounceCount) {
          this.syncPowerState(NO, 'ADB disconnected');
        }
        return;
      }

      const powerResult = await this.adb.detectPowerState();
      if (powerResult.result) {
        this.syncPowerState(powerResult.awake, 'state poll');
      }

      if (this.input.length > 0) {
        const currentApp = await this.adb.detectCurrentAppId();
        if (currentApp.result && currentApp.appId) {
          this.parseInput(currentApp.appId);
        }
      }

      if (this.enablePlaybackSensor) {
        const playback = await this.adb.detectPlayback();
        if (playback.result) {
          const isPlaying = playback.playing ? YES : NO;
          if (this.isPlaying !== isPlaying) {
            this.isPlaying = isPlaying;
            this.accessoryPlaybackSensorService.updateCharacteristic(Characteristic.MotionDetected, this.isPlaying);
            this.displayInfo(`Playback - ${this.isPlaying ? 'On' : 'Off'}`);
          }
        }
      }
    }).catch(error => {
      this.displayDebug(`Poll error: ${error}`);
    }).finally(() => {
      this.scheduleNextPoll(this.interval);
    });
  }

  updateConnectionState(connected) {
    if (connected) {
      this.connectedCount += 1;
      this.disconnectedCount = 0;
      if (!this.connectedState && this.connectedCount >= this.connectionDebounceCount) {
        this.connectedState = YES;
        this.displayDebug('ADB connected');
      }
    } else {
      this.connectedCount = 0;
      this.disconnectedCount += 1;
      if (this.connectedState && this.disconnectedCount >= this.connectionDebounceCount) {
        this.connectedState = NO;
        if (!this.powerState && this.suppressSleepingDisconnectLogs) {
          this.displayDebug('ADB transport sleeping/disconnected');
        } else {
          this.displayDebug('ADB not connected');
        }
      }
    }
  }

  startSleepingKeepAliveLoop() {
    if (!this.keepAdbAliveWhenSleeping) return;
    this.displayDebug(`Sleeping keepalive enabled. Interval: ${this.keepAliveInterval}ms`);
    this.keepaliveNext = Date.now();
    this.scheduleSleepingKeepAlive();
  }

  async scheduleSleepingKeepAlive() {
    if (this.isShuttingDown) return;
    const now = Date.now();
    const delay = Math.max(0, this.keepaliveNext - now);
    this.keepAliveTimer = setTimeout(() => this.runSleepingKeepAlive(), delay);
  }

  async runSleepingKeepAlive() {
    if (this.isShuttingDown) return;
    if (this.adb.queue.isBusy || this.powerOnChange || this.isPowerSettling() || this.powerState) {
      this.displayDebug('Sleeping keepalive skipped because device is busy or awake');
      this.keepaliveNext = Date.now() + this.keepAliveInterval;
      this.scheduleSleepingKeepAlive();
      return;
    }

    this.displayDebug('Sleeping keepalive - Starting');
    try {
      const keepaliveResult = await this.adb.enqueue(() => this.adb.keepalive());
      if (keepaliveResult && keepaliveResult.result) {
        this.displayDebug('Sleeping keepalive - Success');
      } else {
        this.displayDebug(`Sleeping keepalive - Failed: ${keepaliveResult ? keepaliveResult.message : 'No output'}`);
      }
    } catch (error) {
      this.displayDebug(`Sleeping keepalive error: ${error}`);
    }

    this.keepaliveNext = Date.now() + this.keepAliveInterval;
    this.scheduleSleepingKeepAlive();
  }

  stopSleepingKeepAliveLoop() {
    if (this.keepAliveTimer) {
      clearTimeout(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  handleOnOff() {
    this.accessoryService.getCharacteristic(Characteristic.Active)
      .onSet(state => {
        const requestedPowerState = state === Characteristic.Active.ACTIVE;
        if (requestedPowerState === this.powerState || this.powerOnChange === YES) return;

        this.powerOnChange = YES;
        this.powerSettlingUntil = Date.now() + this.powerSettleDelay;

        if (requestedPowerState) {
          this.syncPowerState(YES, 'Power On requested');
          this.adb.enqueue(async () => {
            const output = await this.adb.powerOn();
            if (!output.result) {
              this.displayInfo('Power On - Failed');
              this.displayDebug(output.message);
              this.syncPowerState(NO, 'Power On failed');
            } else {
              this.displayDebug('Power On flow started');
            }
            this.powerOnChange = NO;
          }).catch(error => {
            this.powerOnChange = NO;
            this.displayInfo('Power On - Failed');
            this.displayDebug(error);
            this.syncPowerState(NO, 'Power On failed');
          });
        } else {
          this.syncPowerState(NO, 'Power Off requested');
          this.adb.enqueue(async () => {
            const output = await this.adb.powerOff();
            if (!output.result) {
              this.displayInfo('Power Off - Failed');
              this.displayDebug(output.message);
              this.syncPowerState(YES, 'Power Off failed');
            } else {
              this.displayDebug('Power Off flow started');
            }
            this.powerOnChange = NO;
          }).catch(error => {
            this.powerOnChange = NO;
            this.displayInfo('Power Off - Failed');
            this.displayDebug(error);
            this.syncPowerState(YES, 'Power Off failed');
          });
        }
      })
      .onGet(() => (this.powerState ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE));
  }

  handleVolume() {
    if (this.enableSpeaker === NO) return;

    this.accessoryTVSpeakerService.getCharacteristic(Characteristic.VolumeSelector)
      .onSet(state => {
        const key = state ? this.config.volumedown || 'KEYCODE_VOLUME_DOWN' : this.config.volumeup || 'KEYCODE_VOLUME_UP';
        this.adb.enqueue(() => this.adb.sendKeycode(key)).catch(error => {
          this.displayDebug(`Volume - Failed: ${error}`);
        });
      });
  }

  handleInputs() {
    if (this.input.length <= 0) return;

    this.accessoryService.getCharacteristic(Characteristic.ActiveIdentifier)
      .onSet(state => {
        if (this.inputOnChange === YES) return;

        let adbCommand = 'input keyevent KEYCODE_HOME';
        this.inputOnChange = YES;

        if (this.input[state]) {
          const input = this.input[state];
          if (input.id !== HOME_APP_ID && input.id !== OTHER_APP_ID) {
            adbCommand = input.adb || input.id;
          }
        }

        this.adb.enqueue(() => this.adb.launchApp(adbCommand)).then(result => {
          if (!result.result) {
            throw result.message;
          }
          this.inputIndex = state;
          this.accessoryService.updateCharacteristic(Characteristic.ActiveIdentifier, state);
          this.displayInfo(`Input - Current app: ${this.input[state] ? this.input[state].id : 'Unknown'}`);
        }).catch(error => {
          this.displayInfo("Input - Can't open");
          this.displayDebug(error);
        }).finally(() => {
          this.inputOnChange = NO;
        });
      })
      .onGet(() => this.inputIndex);
  }

  handleSwitchInput(switchInput) {
    if (!switchInput) return;

    const index = switchInput.subtype;
    switchInput.getCharacteristic(Characteristic.On)
      .onSet(state => {
        if (this.inputOnChange === YES) return;

        let adbCommand = 'input keyevent KEYCODE_HOME';
        const input = this.input[index];
        if (state && input) {
          adbCommand = input.adb || input.id;
        }

        this.inputOnChange = YES;
        this.adb.enqueue(() => this.adb.launchApp(adbCommand)).then(result => {
          if (!result.result) throw result.message;
          this.switchInputs.currentId = input ? input.id : HOME_APP_ID;
          this.switchInputs.turnOn();
          this.displayInfo(`Switch - Current app: ${input ? input.id : 'Unknown'}`);
        }).catch(error => {
          this.displayInfo('Switch - Can\'t open');
          this.displayDebug(error);
        }).finally(() => {
          this.inputOnChange = NO;
        });
      })
      .onGet(() => this.powerState ? this.switchInputs.currentId === switchInput.id : false);
  }

  handleMediaAsSensor() {
    this.accessoryPlaybackSensorService.getCharacteristic(Characteristic.MotionDetected)
      .onGet(() => this.isPlaying);
  }

  handleRemoteControl() {
    this.accessoryService.getCharacteristic(Characteristic.RemoteKey)
      .onSet(state => {
        let key = 'KEYCODE_HOME';

        switch (state) {
          case Characteristic.RemoteKey.REWIND:
            key = 'KEYCODE_MEDIA_REWIND';
            break;
          case Characteristic.RemoteKey.FAST_FORWARD:
            key = 'KEYCODE_MEDIA_FAST_FORWARD';
            break;
          case Characteristic.RemoteKey.NEXT_TRACK:
            key = 'KEYCODE_MEDIA_NEXT';
            break;
          case Characteristic.RemoteKey.PREVIOUS_TRACK:
            key = 'KEYCODE_MEDIA_PREVIOUS';
            break;
          case Characteristic.RemoteKey.ARROW_UP:
            key = this.config.upbutton || 'KEYCODE_DPAD_UP';
            break;
          case Characteristic.RemoteKey.ARROW_DOWN:
            key = this.config.downbutton || 'KEYCODE_DPAD_DOWN';
            break;
          case Characteristic.RemoteKey.ARROW_LEFT:
            key = this.config.leftbutton || 'KEYCODE_DPAD_LEFT';
            break;
          case Characteristic.RemoteKey.ARROW_RIGHT:
            key = this.config.rightbutton || 'KEYCODE_DPAD_RIGHT';
            break;
          case Characteristic.RemoteKey.SELECT:
            key = this.config.selectbutton || 'KEYCODE_ENTER';
            break;
          case Characteristic.RemoteKey.BACK:
            key = this.config.backbutton || 'KEYCODE_BACK';
            break;
          case Characteristic.RemoteKey.EXIT:
            key = 'KEYCODE_HOME';
            break;
          case Characteristic.RemoteKey.PLAY_PAUSE:
            key = this.config.playpausebutton || 'KEYCODE_MEDIA_PLAY_PAUSE';
            break;
          case Characteristic.RemoteKey.INFORMATION:
            key = this.config.infobutton || 'KEYCODE_INFO';
            break;
          default:
            key = 'KEYCODE_HOME';
        }

        this.adb.enqueue(() => this.adb.sendKeycode(key)).catch(error => {
          this.displayDebug(`Remote Control - Can't send: ${key}`);
          this.displayDebug(error);
        });
      });
  }

  parseInput(appId) {
    if (!appId || appId === this.currentAppID || this.input.length <= 0) return;
    let foundIndex = false;

    this.currentAppID = appId;
    this.input.forEach((input, index) => {
      if (appId === input.id) foundIndex = index;
    });

    if (foundIndex !== false) {
      this.inputIndex = foundIndex;
    } else if (!this.hideOther) {
      let humanName = appId.split('.').map((part, index) => {
        if (index === 0) return part.charAt(0).toUpperCase() + part.slice(1);
        return part.charAt(0).toUpperCase() + part.slice(1);
      }).join(' ');
      this.inputIndex = this.input.length - 1;
      if (this.input[this.inputIndex]) {
        this.input[this.inputIndex].id = appId;
        if (this.input[this.inputIndex].service) {
          if (!this.hidenumber) {
            const displayIndex = this.inputIndex + 1;
            const prefix = displayIndex < 10 ? `0${displayIndex}` : displayIndex;
            humanName = `${prefix} ${humanName}`;
          }
          this.input[this.inputIndex].service.updateCharacteristic(Characteristic.ConfiguredName, humanName);
        }
      }
    }

    this.accessoryService.updateCharacteristic(Characteristic.ActiveIdentifier, this.inputIndex);
    this.displayInfo(`Input - Current app id - ${this.currentAppID}`);
  }

  syncPowerState(isAwake, source = 'unknown') {
    const nextPowerState = isAwake ? YES : NO;
    const changed = this.powerState !== nextPowerState;
    this.powerState = nextPowerState;

    if (this.accessoryService) {
      this.accessoryService.updateCharacteristic(
        Characteristic.Active,
        nextPowerState ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
      );
    }

    if (changed) {
      this.displayInfo(nextPowerState ? this.green('Awake') : this.red('Sleep'));
    } else {
      this.displayDebug(`Power state confirmed ${nextPowerState ? 'awake' : 'sleep'} from ${source}`);
    }
  }

  shutdown() {
    this.isShuttingDown = YES;
    this.stopPollLoop();
    this.stopSleepingKeepAliveLoop();
    this.adb.stop();
  }

  displayDebug(...args) {
    if (!this.debug) return;
    args.unshift(`${this.name} - 🐞`);
    args.push('\x1b[0m');
    this.log.info(...args);
  }

  displayInfo(...args) {
    args.unshift(`${this.name} - 🤖`);
    this.log.info(...args);
  }

  red(text) { return `\x1B[31m${text}\x1B[0m`; }
  green(text) { return `\x1B[32m${text}\x1B[0m`; }
}

class ADBPluginPlatform {
  constructor(log, config, api) {
    if (!config) return;
    this.log = log;
    this.api = api;
    this.config = config;
    if (this.api && typeof this.api.on === 'function') {
      this.api.on('didFinishLaunching', this.initAccessory.bind(this));
    }
  }

  initAccessory() {
    if (Array.isArray(this.config.accessories)) {
      for (const accessory of this.config.accessories) {
        if (accessory) new ADBPlugin(this.log, accessory, this.api);
      }
    } else if (this.config.accessories) {
      this.log.info('Cannot initialize. Type: %s', typeof this.config.accessories);
    } else {
      this.log.info('-------------------------------------------------');
      this.log.info('Please add one or more accessories in your config');
      this.log.info('-------------------------------------------------');
    }
  }

  removeAccessory(platformAccessory) {
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
  }
}
