let wol = require('wake_on_lan');
let adb = require('nodejs-adb-wrapper');
let { exec } = require('child_process');
let Service, Characteristic;

const PLUGIN_NAME = 'homebridge-adb';
const PLATFORM_NAME = 'HomebridgeADB';

// Yes/No
const YES = true;
const NO = false;
// Empty
const EMPTY = "";
// App ids
const OTHER_APP_ID = "other";
const HOME_APP_ID = "home";

module.exports = (homebridge) => {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ADBPluginPlatform, true);
};

class ADBPlugin {
	constructor(log, config, api) {
		if (!config) return;

		this.log = log;
		this.config = config;
		this.api = api;

		// Configuration
		// Name
		this.name = this.config.name || 'Android Accessory';
		// Path
		this.path = this.config.path || "";
		// IP
		this.ip = this.config.ip;
		if (!this.ip) {
			this.log.error(`\n\nPlease provide IP for this accessory: ${this.name}\n`);
			return;
		}
		// Mac
		this.mac = this.config.mac || "";
		// Interval
		this.interval = this.config.interval || 2500;
		if (this.interval < 500) this.interval = 500;
		// Show more debug
		this.debug = this.config.debug || false;
		// Exec timeout
		this.timeout = this.config.timeout || 2500;
		if (this.timeout < 1000) this.timeout = 1000;
		// Shell command timeout
		this.shellTimeout = this.config.shelltimeout || 30000;
		if (this.shellTimeout < 1000) this.shellTimeout = 1000;

		// Connect device during plugin startup without forcing display wake
		this.connectOnStartup = this.config.connectonstartup || false;
		this.startupCommand = this.config.startupcommand || "";

		// Keep ADB transport alive while device is sleeping
		this.keepAdbAliveWhenSleeping = this.config.keepadbalivewhensleeping || false;
		this.keepAliveCommand = this.config.keepalivecommand || this.config.startupcommand || "";
		this.keepAliveInterval = this.config.keepaliveinterval || 30000;
		if (this.keepAliveInterval < 10000) this.keepAliveInterval = 10000;

		// Debounce noisy connect/disconnect logs
		this.connectionDebounceCount = this.config.connectiondebouncecount || 2;
		this.suppressSleepingDisconnectLogs = this.config.suppresssleepingdisconnectlogs !== false;

		this.connectedState = false;
		this.disconnectedCount = 0;
		this.connectedCount = 0;
		this.keepAliveInProgress = false;
		this.keepAliveLoop = null;

		// Delay after startup connect before model/state detection
		this.startupSettleDelay = this.config.startupsettledelay ?? 500;
		if (this.startupSettleDelay < 0) this.startupSettleDelay = 0;

		// Prevent keepalive from running while power state is settling
		this.powerSettleDelay = this.config.powersettledelay ?? 20000;
		if (this.powerSettleDelay < 0) this.powerSettleDelay = 0;

		this.powerSettlingUntil = 0;

		this.fastPowerOff = this.config.fastpoweroff || false;

		// Inputs
		this.input = this.config.inputs || [];
		this.inputOnChange = NO;
		this.inputIndex = 0;
		this.hidenumber = this.config.hidenumber || false;
		this.hideHome = this.config.hidehome || false;
		this.hideOther = this.config.hideother || false;
		if (!this.hideHome) this.input.unshift({ "name": "Home", "id": HOME_APP_ID });
		if (!this.hideOther) this.input.push({ "name": "Other", "id": OTHER_APP_ID });
		this.hiddenInputSlots = Number(this.config.hiddeninputslots ?? 0);
		if (!Number.isFinite(this.hiddenInputSlots)) this.hiddenInputSlots = 0;
		this.hiddenInputSlots = Math.floor(this.hiddenInputSlots);
		if (this.hiddenInputSlots < 0) this.hiddenInputSlots = 0;
		const maxHiddenInputSlots = Math.max(0, 50 - this.input.length);
		if (this.hiddenInputSlots > maxHiddenInputSlots) this.hiddenInputSlots = maxHiddenInputSlots;
		this.inputSourceCount = Math.min(50, this.input.length + this.hiddenInputSlots);
		// Category
		this.category = this.config.category || "TELEVISION";
		this.category = this.category.toUpperCase();
		// Speaker
		this.enableSpeaker = this.config.skipSpeaker ? NO : YES;
		// Playback Sensor
		this.isPlaying = NO;
		this.enablePlaybackSensor = this.config.playbacksensor || NO;
		this.playbackSensorDelayOff = this.config.playbacksensordelay || 10000;
		this.playbackSensorExclude = this.config.playbacksensorexclude || "";
		// State detection
		this.stateAdbCommand = this.config.stateAdbCommand;
		this.stateAdbOutputAwake = this.config.stateAdbOutputAwake;
		// Power
		this.powerOnChange = NO;
		this.wolLoop = EMPTY;
		this.retryPowerOn = this.config.poweronretry || 10;
		// App
		this.currentAppID = HOME_APP_ID;
		// Custom launcher app id
		this.launcherid = this.config.launcherid;

		// Accessory status
		this.adb = new adb(this.ip, {
			path: this.path,
			interval: this.interval,
			timeout: this.timeout,
			playbackDelayOff: this.playbackSensorDelayOff,
			retryPowerOn: this.retryPowerOn,
			keycodePowerOn: this.config.poweron,
			keycodePowerOff: this.config.poweroff,
			stateAdbCommand: this.stateAdbCommand,
			stateAdbOutputAwake: this.stateAdbOutputAwake,
			launcherid: this.launcherid
		});

		/**
		 * Create the Homekit Accessories
		 */

		// generate a UUID
		const uuid = this.api.hap.uuid.generate('homebridge:adb-plugin' + this.ip + this.name);
		const uuidos = this.api.hap.uuid.generate('homebridge:adb-plugin' + this.ip + this.name + "OccupancySensor");
		const uuidsi = this.api.hap.uuid.generate('homebridge:adb-plugin' + this.ip + this.name + "SwitchInput");

		// create the external accessory
		this.accessory = new this.api.platformAccessory(this.name, uuid);
		// create the playback sensor accessory
		if (this.enablePlaybackSensor == YES) this.accessoryPlaybackSensor = new this.api.platformAccessory(this.name + " Playback Sensor", uuidos);
		// create switch input
		this.switchInputs = new this.api.platformAccessory(this.name + " Switch Inputs", uuidsi);
		this.switchInputsArray = [];
		this.switchInputsService = this.switchInputs.addService(Service.Switch);

		// set the external accessory category
		switch (this.category) {
			case "SPEAKER":
				this.accessory.category = this.api.hap.Categories.SPEAKER;
				break;
			case "TV_STREAMING_STICK":
				this.accessory.category = this.api.hap.Categories.TV_STREAMING_STICK;
				break;
			case "TV_SET_TOP_BOX":
				this.accessory.category = this.api.hap.Categories.TV_SET_TOP_BOX;
				break;
			case "AUDIO_RECEIVER":
				this.accessory.category = this.api.hap.Categories.AUDIO_RECEIVER;
				break;
			case "APPLE_TV":
				this.accessory.category = this.api.hap.Categories.APPLE_TV;
				break;
			default:
				this.accessory.category = this.api.hap.Categories.TELEVISION;
				break;
		}

		// add the accessory service
		this.accessoryService = this.accessory.addService(Service.Television);

		// get accessory information
		this.accessoryInfo = this.accessory.getService(Service.AccessoryInformation);

		// set accessory service name
		this.accessoryService.setCharacteristic(Characteristic.ConfiguredName, this.name);
		this.accessoryService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

		/**
		 * Publish as external accessory
		 * Check ADB connection before publishing the accessory
		 */

		this.displayInfo(`Initializing`);

		this.initialize().catch(error => {
			this.displayInfo(`Initialization failed`);
			if (error) this.displayDebug(`Initialization error message:\n${error}`);
		});
	}



	/**
	 * Initialize accessory startup flow.
	 * Optionally prepares ADB connectivity before initial model/state detection.
	 */
	async initialize() {
		if (this.connectOnStartup) {
			this.displayInfo(`Startup connect - Starting`);

			const output = await this.runConfiguredStartupConnect(`Startup connect`);

			if (output.result) {
				this.displayInfo(`Startup connect - Success`);
			} else {
				this.displayInfo(`Startup connect - Failed`);
				this.displayDebug(`Startup connect error message: ${output.message}`);
			}

			// Let the wrapper/network settle before model/state detection.
			if (this.startupSettleDelay > 0) {
				await new Promise(resolve => setTimeout(resolve, this.startupSettleDelay));
			}
		}

		// Get the accessory information and publish external accessories.
		await this.createAccessories();

		// Register ADB update event handlers before starting the update loop.
		this.registerUpdateEvents();

		// Register HomeKit handlers.
		this.handleOnOff();
		this.handleInputs();
		this.handleVolume();
		this.handleRemoteControl();

		// Start the ADB update loop.
		this.adb.update().catch(error => {
			if (error) this.displayDebug(`Update error message:\n${error}`);
		});

		// Optional sleeping keepalive loop.
		this.startSleepingKeepAliveLoop();
	}

	/**
	 * Register ADB update event handlers.
	 */
	registerUpdateEvents() {
		let count = 0;

		this.adb.on(`update`, (type, message, debug) => {
			switch (type) {
				case `firstrun`:
					break;

				// Connection events
				case `connecting`:
					this.displayDebug("Connecting...");
					break;

				case `timeout`:
					this.displayDebug("Timeout...");
					break;

				case `status`:
					if (count++ == 0) this.displayDebug(`Alive: ${Date()}`);
					if (count >= 60) count = 0;
					break;

				case `connected`:
					this.disconnectedCount = 0;
					this.connectedCount++;

					if (!this.connectedState && this.connectedCount >= this.connectionDebounceCount) {
						this.connectedState = true;
						this.displayDebug("Connected");
					}
					break;

				case `disconnected`:
					this.connectedCount = 0;
					this.disconnectedCount++;

					/*
					* When the TV is logically sleeping, ADB transport flapping is expected.
					* Do not spam logs unless suppresssleepingdisconnectlogs is disabled.
					*/
					if (!this.adb.getPowerStatus() && this.suppressSleepingDisconnectLogs) {
						if (this.connectedState && this.disconnectedCount >= this.connectionDebounceCount) {
							this.connectedState = false;
							this.displayDebug("ADB transport sleeping/disconnected");
						}
						break;
					}

					if (this.connectedState && this.disconnectedCount >= this.connectionDebounceCount) {
						this.connectedState = false;
						this.displayDebug("Not connected");
					}

					break;

				case `authorized`:
					this.displayDebug("Authorized");
					break;

				case `unauthorized`:
					this.displayInfo(`\n\n\t${this.red("WARNING: Device unauthorized")}.\n\tCheck your Android device for authorization popup.\n`);
					break;

				// App events
				case `appChange`: {
					const currentAppId = this.adb.getCurrentAppId();

					this.displayDebug(`App change to ${currentAppId}`);
					this.parseInput(currentAppId);

					this.switchInputs.currentId = currentAppId;
					this.switchInputs.turnOn(`from app change event`);
					break;
				}

				case `playback`:
					if (this.enablePlaybackSensor == YES) {
						if (this.isPlaying == this.adb.getPlaybackStatus()) return;

						this.isPlaying = this.playbackSensorExclude.includes(this.currentAppID) ? NO : this.adb.getPlaybackStatus() ? YES : NO;
						this.displayInfo(`Playback - ${this.isPlaying ? this.green(`On`) : this.red(`Off`)}`);
						this.accessoryPlaybackSensorService.updateCharacteristic(Characteristic.MotionDetected, this.isPlaying);
						if (debug) this.displayDebug("Playback debug:\n" + debug.trim());
					}
					break;

				// Sleep/awake events
				case `awake`:
					this.accessoryService.updateCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);
					this.displayInfo(this.green(`Awake`));
					break;

				case `sleep`:
					this.accessoryService.updateCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE);
					this.displayInfo(this.red(`Sleep`));
					break;

				// Power events
				case `powerOn`:
					this.displayDebug(`Turning power on`);
					break;

				case `powerOff`:
					this.displayDebug(`Turning power off`);
					break;

				case `debugPowerOn`:
					this.displayDebug(`Turning power on: ${message.awake}, ${debug}`);
					break;

				case `debugPowerOff`:
					this.displayDebug(`Turning power off: ${message.awake}, ${debug}`);
					break;

				case `powerOnStatus`:
					this.displayDebug(`Turning power on: ${message}`);
					break;

				case `powerOffStatus`:
					this.displayDebug(`Turning power off: ${message}`);
					break;

				default:
					break;
			}
		});
	}

	/**
	 * Keep ADB transport available while the TV is sleeping.
	 * This should use a connect-only command that does NOT send KEYCODE_WAKEUP/HOME.
	 */
	startSleepingKeepAliveLoop() {
		if (!this.keepAdbAliveWhenSleeping) return;
		if (!this.keepAliveCommand) {
			this.displayDebug(`Sleeping keepalive disabled: no keepalivecommand configured`);
			return;
		}

		this.displayDebug(`Sleeping keepalive enabled. Interval: ${this.keepAliveInterval}ms`);

		this.keepAliveLoop = setInterval(async () => {
			if (this.keepAliveInProgress) return;
			if (this.powerOnChange) return;
			if (this.isPowerSettling()) return;

			// Only run this while the TV is logically sleeping.
			if (this.adb.getPowerStatus()) return;

			this.keepAliveInProgress = true;

			try {
				this.displayDebug(`Sleeping keepalive - Starting`);

				let output;

				if (this.isShellCommand(this.keepAliveCommand)) {
					output = await this.runOsShell(this.keepAliveCommand, `Sleeping keepalive`);
				} else {
					output = await this.adb.connect();
				}

				if (output && output.result) {
					this.displayDebug(`Sleeping keepalive - Success`);

					try {
						await this.adb.connect();
					} catch (error) {
						this.displayDebug(`Sleeping keepalive - ADB reconnect failed: ${error}`);
					}
				} else {
					this.displayDebug(`Sleeping keepalive - Failed: ${output ? output.message : 'No output'}`);
				}
			} catch (error) {
				this.displayDebug(`Sleeping keepalive error: ${error}`);
			} finally {
				this.keepAliveInProgress = false;
			}
		}, this.keepAliveInterval);
	}

	/**
	 * Get accessory information to be used in Home app as identifier
	 */
	async createAccessories() {
		if (!this.adb.isConnected()) await this.adb.connect();
		let { result, message } = await this.adb.model();

		// Get accessory information
		if (!result) message = ["", "", ""];
		else message = message.split(" | ");

		// Create inputs
		this.createInputs();
		this.createSwitchInputs();

		// Publish tv accessories
		this.createTV(message);

		// Create speaker services
		this.createTVSpeakers();

		// Playback sensor
		this.createPlaybackSensor(message);

		// Display error when can't connect to accessory
		if (!result) this.log.error(`\n\nWARNING:\nUnrecognized accessory - "${this.name}".\nPlease check if the accessory's IP address is correct.\nIf your accessory is turned OFF, please turn it ON.\n`);
		// Accessory finish initialzing
		else this.displayInfo(`\x1B[01;93mAccessory initialized.\x1B[0m`);
	}



	/**
	 * Create Accessory Input Source Services
	 * These are the inputs the user can select from.
	 * When a user selected an input the corresponding Identifier Characteristic
	 * is sent to the Accessory Service ActiveIdentifier Characteristic handler.
	 * Optional hidden placeholder inputs can be reserved for future changes.
	 * HomeKit may require the TV accessory to be removed and re-added when
	 * new input services are added later.
	 */
	createInputs() {
		if (this.input.length <= 0) return;

		for (let i = 0; i < this.inputSourceCount; i++) {
			let input = this.input[i];
			let type = Characteristic.InputSourceType.APPLICATION;
			let configured = Characteristic.IsConfigured.CONFIGURED;
			let targetVisibility = Characteristic.TargetVisibilityState.SHOWN;
			let currentVisibility = Characteristic.CurrentVisibilityState.SHOWN;
			let name = "";

			if (i == 0 && !this.hideHome) type = Characteristic.InputSourceType.HOME_SCREEN;
			else if (i == this.input.length - 1 && !this.hideOther) type = Characteristic.InputSourceType.OTHER;

			let humanNumber = i + 1;
			if (humanNumber < 10) humanNumber = "0" + (i + 1);

			if (i >= this.input.length || !input.name || !input.id) {
				// Create hidden input when name and id is empty and for future modification
				configured = Characteristic.IsConfigured.NOT_CONFIGURED;
				targetVisibility = Characteristic.TargetVisibilityState.HIDDEN;
				currentVisibility = Characteristic.CurrentVisibilityState.HIDDEN;
				name = `${humanNumber} Hidden Input`;
			} else {
				name = `${input.name}`;
				if (!this.hidenumber) name = `${humanNumber} ${name}`;
			}

			if (targetVisibility == Characteristic.TargetVisibilityState.SHOWN) this.displayDebug(`📺 Input: ${name}`);
			let service = this.accessory.addService(Service.InputSource, `Input ${name}`, i);
			service
				.setCharacteristic(Characteristic.Identifier, i)
				.setCharacteristic(Characteristic.ConfiguredName, name)
				.setCharacteristic(Characteristic.InputSourceType, type)
				.setCharacteristic(Characteristic.TargetVisibilityState, targetVisibility)
				.setCharacteristic(Characteristic.CurrentVisibilityState, currentVisibility)
				.setCharacteristic(Characteristic.IsConfigured, configured);
			this.accessoryService.addLinkedService(service);

			if (configured == Characteristic.IsConfigured.CONFIGURED) {
				this.input[i].service = service;
			}
		};
	}

	/**
	 * Create a playback sensor based on video playback
	 * Due to limitation of ADB, support for playback will be limited
	 * @param {string} output ADB output
	 */
	createSwitchInputs() {
		if (this.input.length <= 0) return;

		this.switchInputs.currentId = this.adb.getCurrentAppId();
		this.switchInputs.add = service => {
			this.switchInputsArray.push(service);
		}
		this.switchInputs.turnOn = (trace = 'from unknown') => {
			this.switchInputsArray.forEach(accessory => {
				accessory.updateCharacteristic(Characteristic.On, accessory.id == this.switchInputs.currentId ? YES : NO);
			});
			this.displayDebug(`🎚️ Updating switches`, trace, this.switchInputs.currentId);
		}

		for (let i = 0; i < this.input.length; i++) {
			const input = this.input[i];
			const name = `${input.name}`;

			if (input.switch) {
				let service = this.accessory.addService(Service.Switch, `${name}`, i)
					.setCharacteristic(Characteristic.Name, name)
				service.id = input.id;
				this.handleSwitchInput(service);
				this.switchInputsService.addLinkedService(service);
				this.switchInputs.add(service);

				this.displayDebug(`🎚️ Switch: ${name}`);
			}
		}
	}

	/**
	 * Create television accessory based on ADB information
	 * @param {string} output ADB output
	 */
	createTV(output) {
		this.accessoryInfo
			.setCharacteristic(Characteristic.Model, output[0] || "Android TV")
			.setCharacteristic(Characteristic.Manufacturer, output[1] || "Homebridge ADB")
			.setCharacteristic(Characteristic.SerialNumber, output[2] || this.ip);
		this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessory]);
		this.displayDebug(`TV created`);
	}

	/**
	 * Create a speaker service to allow volume control
	 */
	createTVSpeakers() {
		if (this.enableSpeaker == NO) return;

		this.accessoryTVSpeakerService = this.accessory.addService(Service.TelevisionSpeaker);
		this.accessoryTVSpeakerService
			.setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
			.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.RELATIVE);
		this.accessoryService.addLinkedService(this.accessoryTVSpeakerService);
		this.displayDebug(`Speaker created`);
	}

	/**
	 * Create a playback sensor based on video playback
	 * Due to limitation of ADB, support for playback will be limited
	 * @param {string} output ADB output
	 */
	createPlaybackSensor(output) {
		if (this.enablePlaybackSensor == NO) return;

		// Add playback sensor
		this.accessoryPlaybackSensor.category = this.api.hap.Categories.SENSOR;
		this.accessoryPlaybackSensorInfo = this.accessoryPlaybackSensor.getService(Service.AccessoryInformation);
		this.accessoryPlaybackSensorService = this.accessoryPlaybackSensor.addService(Service.MotionSensor);
		this.handleMediaAsSensor();

		// Publish playback sensor
		this.accessoryPlaybackSensorInfo
			.setCharacteristic(Characteristic.Model, output[0] || "Android")
			.setCharacteristic(Characteristic.Manufacturer, output[1] || "Homebridge ADB")
			.setCharacteristic(Characteristic.SerialNumber, output[2] || this.ip);
		this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessoryPlaybackSensor]);
		this.displayDebug(`Sensor created`);
	}



	/**
	 * Returns true when a configured command is an OS shell command.
	 */
	isShellCommand(command) {
		if (!command || typeof command !== 'string') return false;
		return command.trim().toLowerCase().startsWith('shell ');
	}

	/**
	 * Removes the "shell " prefix used by the plugin config.
	 */
	stripShellPrefix(command) {
		return command.trim().replace(/^shell\s+/i, '');
	}

	/**
	 * Run an OS shell command directly from the plugin.
	 * This bypasses the ADB wrapper so shell power-on scripts can run even while ADB is disconnected.
	 */
	runOsShell(command, label = 'Shell') {
		const shellCommand = this.stripShellPrefix(command);

		this.displayDebug(`${label} - Running shell command: ${shellCommand}`);

		return new Promise(resolve => {
			exec(shellCommand, { timeout: this.shellTimeout }, (error, stdout, stderr) => {
				const message = (stdout || stderr || '').trim();

				if (error) {
					resolve({
						result: false,
						message: message || error.message || `${label} failed`
					});
					return;
				}

				resolve({
					result: true,
					message: message || `${label} completed`
				});
			});
		});
	}

	/**
	 * Run the configured power-on command.
	 * Shell commands are allowed to run even if ADB is currently disconnected.
	 */
	async runConfiguredPowerOn(reason = 'Power On') {
		const powerOnCommand = this.config.poweron;

		if (this.isShellCommand(powerOnCommand)) {
			const output = await this.runOsShell(powerOnCommand, reason);

			if (!output.result) return output;

			// After the shell wake script runs, try to bring the wrapper's ADB state up to date.
			try {
				await this.adb.connect();
			} catch (error) {
				this.displayDebug(`${reason} - ADB reconnect after shell failed: ${error}`);
			}

			return {
				result: true,
				message: output.message || `${reason} succeeded`
			};
		}

		return await this.adb.powerOn();
	}

	/**
	 * Run the configured power-off command.
	 * Shell commands can be used for power-off too, but normal keycodes still use the ADB wrapper.
	 */
	async runConfiguredPowerOff(reason = 'Power Off') {
		const powerOffCommand = this.config.poweroff;

		if (this.isShellCommand(powerOffCommand)) {
			return await this.runOsShell(powerOffCommand, reason);
		}

		/*
		* Fast power-off is intended for one-way sleep commands like KEYCODE_SLEEP.
		* Do not use this with KEYCODE_POWER unless you like haunted toggle behavior.
		*/
		if (this.fastPowerOff && powerOffCommand && powerOffCommand.trim().toUpperCase() === 'KEYCODE_SLEEP') {
			const output = await this.adb.sendKeycode(powerOffCommand);

			if (!output.result) return output;

			return {
				result: true,
				message: `${reason} sent ${powerOffCommand}`
			};
		}

		return await this.adb.powerOff();
	}

	/**
	 * Run the configured startup command.
	 * This should prepare the ADB transport without forcing display wake.
	 */
	async runConfiguredStartupConnect(reason = 'Startup connect') {
		const startupCommand = this.startupCommand;

		if (this.isShellCommand(startupCommand)) {
			const output = await this.runOsShell(startupCommand, reason);

			if (!output.result) return output;

			try {
				await this.adb.connect();
			} catch (error) {
				this.displayDebug(`${reason} - ADB reconnect after startup command failed: ${error}`);
			}

			return {
				result: true,
				message: output.message || `${reason} succeeded`
			};
		}

		// Fallback: just attempt normal ADB connect.
		try {
			const output = await this.adb.connect();
			return {
				result: true,
				message: output.message || `${reason} connected`
			};
		} catch (error) {
			return {
				result: false,
				message: error
			};
		}
	}

	isPowerSettling() {
		return Date.now() < this.powerSettlingUntil;
	}

	/**
	 * Handle On/Off
	 */
	handleOnOff() {
		this.accessoryService.getCharacteristic(Characteristic.Active)
			.onSet(async state => {
				if (state == this.adb.getPowerStatus() || this.powerOnChange == YES) return;

				this.powerOnChange = YES;
				this.powerSettlingUntil = Date.now() + this.powerSettleDelay;

				if (state) {
					// Power On
					this.displayDebug("Trying to turn ON accessory. This will take awhile, please wait...");

					try {
						let output;

						/*
						* Shell power-on gets first priority.
						* This allows scripts like:
						* shell /bin/bash /var/lib/homebridge/adb/wake-tcl-tv.sh
						* to run even when ADB is disconnected.
						*/
						if (this.isShellCommand(this.config.poweron)) {
							output = await this.runConfiguredPowerOn("Power On");
						} else if (this.mac) {
							this.displayDebug("Wake On LAN - Sending magic");

							output = await new Promise(resolve => {
								wol.wake(`${this.mac}`, wol.WakeOptions, error => {
									if (error) {
										resolve({
											result: false,
											message: error
										});
										return;
									}

									this.adb.state().then(({ result, message }) => {
										resolve({ result, message });
									}).catch(error => {
										resolve({
											result: false,
											message: error
										});
									});
								});
							});
						} else {
							output = await this.adb.powerOn();
						}

						if (!output.result) throw output.message;

						this.powerSettlingUntil = Date.now() + this.powerSettleDelay;
						this.powerOnChange = NO;

						if (this.isShellCommand(this.config.poweron)) {
							this.displayDebug("Power On - Shell wake success");
						} else if (this.mac) {
							this.displayDebug("Wake On LAN - Success");
						} else {
							this.displayDebug("Power On - Success");
						}

						this.accessoryService.updateCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);
					} catch (error) {
						this.powerSettlingUntil = Date.now() + this.powerSettleDelay;
						this.powerOnChange = NO;

						if (this.mac && !this.isShellCommand(this.config.poweron)) {
							this.displayInfo("Wake On LAN - Failed");
							if (error) this.displayDebug(`WOL error message:\n${error}`);
						} else {
							this.displayInfo("Power On - Failed");
							if (error) this.displayDebug(`Power on error message: ${error}`);
						}

						this.accessoryService.updateCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE);
					}
				} else {
					// Power Off
					this.displayDebug("Trying to turn OFF accessory");

					try {
						const output = await this.runConfiguredPowerOff("Power Off");

						if (!output.result) throw output.message;

						this.powerSettlingUntil = Date.now() + this.powerSettleDelay;
						this.powerOnChange = NO;
						this.displayDebug("Power Off - Success");

						this.accessoryService.updateCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE);
					} catch (error) {
						this.powerSettlingUntil = Date.now() + this.powerSettleDelay;
						this.powerOnChange = NO;
						this.displayInfo("Power Off - Failed");

						this.accessoryService.updateCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);

						if (error) this.displayDebug(`Power off error message: ${error}`);
					}
				}
			}).onGet(() => this.adb.getPowerStatus() ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
	}

	/**
	 * Handle volume control
	 */
	handleVolume() {
		if (this.enableSpeaker == NO) return;

		this.accessoryTVSpeakerService.getCharacteristic(Characteristic.VolumeSelector)
			.onSet(state => {
				this.adb.sendKeycode(state ? this.config.volumedown || "KEYCODE_VOLUME_DOWN" : this.config.volumeup || "KEYCODE_VOLUME_UP").then(({ result, message }) => {
					if (!result) throw message;
					this.displayDebug(`Volume - ${state ? 'Increased' : 'Decreased'}`);
				}).catch(error => {
					this.displayDebug(`Volume - Failed`);
					if (error) this.displayDebug(`Volume error message:\n${error}`);
				});
			});
	}

	/**
	 * Handle input change
	 */
	handleInputs() {
		if (this.input.length <= 0) return;

		this.accessoryService.getCharacteristic(Characteristic.ActiveIdentifier)
			.onSet(state => {
				if (this.inputOnChange == YES) return;

				let adb = "input keyevent KEYCODE_HOME";

				this.inputOnChange = YES;

				// Accessory what kind of command that the input is
				if (this.input[state].id != HOME_APP_ID && this.input[state].id != OTHER_APP_ID) {
					let type = this.input[state].id.trim();
					adb = this.input[state].adb;

					if (!adb && !type.includes(" ") && type.includes(".")) adb = type;
				}

				this.adb.launchApp(adb).then(({ result, message }) => {
					if (!result) throw message;

					this.inputIndex = state;
					this.accessoryService.updateCharacteristic(Characteristic.ActiveIdentifier, state < 0 ? 0 : state);

					this.inputOnChange = NO;
					this.displayInfo(`Input - Current app: ${this.input[state].id}`);
				}).catch(error => {
					this.inputOnChange = NO;
					this.displayInfo(`Input - Can't open: ${this.input[state].id}`)
					if (error) this.displayDebug(`Launch error message:\n${error}`);
				});
			})
			.onGet(() => this.inputIndex);
	}

	/**
	 * Handle control center remote controll
	 */
	handleSwitchInput(switchInput) {
		if (!switchInput) return;

		const index = switchInput.subtype;

		switchInput.getCharacteristic(Characteristic.On)
			.onSet(state => {
				if (this.inputOnChange == YES) return;

				const appId = this.input[index].id.trim();
				let adb = "input keyevent KEYCODE_HOME";

				this.inputOnChange = YES;

				if (state) {
					// Accessory what kind of command that the input is
					adb = this.input[index].adb;

					if (!adb && !appId.includes(" ") && appId.includes(".")) adb = appId;
				}

				this.adb.launchApp(adb).then(({ result, message }) => {
					if (!result) throw message;

					this.switchInputs.currentId = this.adb.getCurrentAppId();
					this.switchInputs.turnOn(`from switches handle`);

					this.inputOnChange = NO;
					this.displayInfo(`Switch - Current app: ${appId}`);
				}).catch(error => {
					this.inputOnChange = NO;
					this.displayInfo(`Switch - Can't open: ${appId}`);
					if (error) this.displayDebug(`Launch error message:\n${error}`);
				});
			})
			.onGet(() => this.adb.getPowerStatus() ? this.switchInputs.currentId == switchInput.id ? true : false : false);
	}

	/**
	 * Handle playback sensor
	 */
	handleMediaAsSensor() {
		this.accessoryPlaybackSensorService.getCharacteristic(Characteristic.MotionDetected)
			.onGet(() => this.isPlaying);
	}

	/**
	 * Handle control center remote control
	 */
	handleRemoteControl() {
		this.accessoryService.getCharacteristic(Characteristic.RemoteKey)
			.onSet(state => {
				var key = "KEYCODE_HOME";

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
				}

				this.adb.sendKeycode(key).then(({ result, message }) => {
					if (!result) throw message;
					this.displayDebug(`Remote Control - Sending: ${key}`);
				}).catch(error => {
					this.displayDebug(`Remote Control - Can't send: ${key}`)
					if (error) this.displayDebug(`Remote error message:\n${error}`);
				});
			});
	}


	// Output text in color
	red(text) { return `\x1B[31m${text}\x1B[0m`; }
	green(text) { return `\x1B[32m${text}\x1B[0m`; }

	/**
	 * A helper parse app id into usable form
	 * @param {string} appId Android app id string
	 */
	parseInput(appId) {
		if (!appId || appId == this.currentAppID || this.input.length <= 0 || appId == this.input[this.inputIndex].id) return;

		let index = false;

		this.currentAppID = appId;
		this.input.forEach((input, i) => {
			if (appId == input.id) index = i;
		});
		if (index !== false) this.inputIndex = index;

		// Other app, extract human readable name from app id
		if (index === false && !this.hideOther) {
			let name = appId.split(".");
			let humanName = "";
			let i = 0;

			// Extract human readable name from app package name
			while (name[i]) {
				name[i] = name[i].charAt(0).toUpperCase() + name[i].slice(1);
				if (i > 0)
					if (name[i] != "Com" && name[i] != "Android")
						if (name[i] == "Vending") humanName += "Play Store";
						else if (name[i] == "Gm") humanName += "GMail";
						else if (name[i].toLowerCase() == "tv") humanName += (" " + "TV");
						else humanName += (" " + name[i]);
				i++;
			}
			humanName = humanName.trim();
			if (humanName != "Other") humanName = `${humanName.trim()}`;

			this.inputIndex = this.input.length - 1;
			if (this.input[this.inputIndex]) this.input[this.inputIndex].id = appId;
			if (this.input[this.inputIndex].service) {
				if (!this.hidenumber) {
					let index = this.inputIndex + 1
					if (index < 10) index = `0${index}`;
					humanName = `${index} ${humanName}`;
				}
				this.input[this.inputIndex].service.updateCharacteristic(Characteristic.ConfiguredName, `${humanName}`);
			}
		}

		// Set the accessory input to current selected app
		this.accessoryService.updateCharacteristic(Characteristic.ActiveIdentifier, this.inputIndex);
		this.displayInfo(`Input - Current app id - \x1b[4m${this.currentAppID}\x1b[0m`);
	}

	/**
	 * A helper to output log, only appeared after with debug config set to true
	 * @param {string} text text to display in Homebridge log
	 */
	displayDebug(...args) {
		args.unshift(`\x1b[2m${this.name} - 🐞`);
		args.push(`\x1b[0m`);
		if (this.debug) this.log.info(...args);
	}

	/**
	 * A helper to output log
	 * @param {string} text text to display in Homebridge log
	 */
	displayInfo(...args) {
		args.unshift(`${this.name} - 🤖`);
		this.log.info(...args);
	}
}

class ADBPluginPlatform {
	constructor(log, config, api) {
		if (!config) return;

		this.log = log;
		this.api = api;
		this.config = config;

		if (this.api) this.api.on('didFinishLaunching', this.initAccessory.bind(this));
	}

	initAccessory() {
		// read from config.accessories
		if (this.config.accessories && Array.isArray(this.config.accessories)) {
			for (let accessory of this.config.accessories) {
				if (accessory) new ADBPlugin(this.log, accessory, this.api);
			}
		} else if (this.config.accessories) {
			this.log.info('Cannot initialize. Type: %s', typeof this.config.accessories);
		}

		if (!this.config.accessories) {
			this.log.info('-------------------------------------------------');
			this.log.info('Please add one or more accessories in your config');
			this.log.info('-------------------------------------------------');
		}
	}

	removeAccessory(platformAccessory) {
		this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
	}
}
