const noble = require("@abandonware/noble");

function log(message) {
  console.log(`[homebridge-ledstrip]:`, message);
}

function hslToRgb(h, s, l) {
  let r, g, b;

  if (s == 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

module.exports = class Device {
  constructor(uuid) {
    this.uuid = uuid;
    this.connected = false;
    this.power = false;
    this.brightness = 100;
    this.hue = 0;
    this.saturation = 0;
    this.l = 0.5;
    this.peripheral = undefined;
    this.write = undefined;
    this.connectPromise = null;
    this.commandQueue = Promise.resolve();
    this.scanning = false;

    noble.on("stateChange", (state) => {
      if (state == "poweredOn") {
        this.startScanning();
      } else {
        this.stopScanning();
        if (this.peripheral) this.peripheral.disconnectAsync().catch(() => {});
        this.connected = false;
        this.write = undefined;
      }
    });

    noble.on("discover", async (peripheral) => {
      if (peripheral.uuid === this.uuid) {
        if (this.connected || this.connectPromise) return;
        log(`Discovered target device: ${peripheral.uuid}`);
        this.peripheral = peripheral;
        this.stopScanning();
        peripheral.once("disconnect", () => {
          this.connected = false;
          this.write = undefined;
          this.peripheral = undefined;
          this.startScanning();
        });

        try {
          await this.ensureConnected();
        } catch (err) {
          log(`Connect failed after discovery: ${err.message}`);
          this.peripheral = undefined;
          this.connected = false;
          this.startScanning(); // Resume scanning
        }
      }
    });
  }

  async ensureConnected() {
    if (!this.peripheral) return;
    if (this.connected && this.write) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      if (this.peripheral.state !== "connected") {
        log(`Connecting to ${this.peripheral.uuid}...`);
        await this.peripheral.connectAsync();
        log(`Connected`);
      }

      const { characteristics } =
        await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
          ["fff0"],
          ["fff3"]
        );
      this.write = characteristics[0];
      this.connected = true;
    })().catch((err) => {
      this.connected = false;
      this.write = undefined;
      log(`Connection error: ${err.message}`);
      throw err;
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  startScanning() {
    if (this.scanning) return;
    this.scanning = true;
    noble.startScanningAsync().catch((err) => {
      this.scanning = false;
      log(`Scan start error: ${err.message}`);
    });
  }

  stopScanning() {
    if (!this.scanning) return;
    this.scanning = false;
    noble.stopScanning();
  }

  enqueueCommand(label, buffer, onSuccess) {
    this.commandQueue = this.commandQueue
      .then(async () => {
        await this.waitForReady();
        if (!this.write) throw new Error("Missing write characteristic");
        return new Promise((resolve, reject) => {
          this.write.write(buffer, true, (err) => {
            if (err) return reject(err);
            resolve();
          });
        });
      })
      .then(() => {
        if (onSuccess) onSuccess();
        log(`${label} command sent`);
      })
      .catch((err) => {
        log(`${label} command failed: ${err.message}`);
        this.connected = false;
        this.write = undefined;
        this.startScanning();
      });

    return this.commandQueue;
  }

  async waitForReady(timeoutMs = 10000) {
    const start = Date.now();
    this.startScanning();

    while (Date.now() - start < timeoutMs) {
      if (this.connected && this.write) return;

      if (this.peripheral && !this.connectPromise && !this.connected) {
        try {
          await this.ensureConnected();
        } catch (_) {
          // Ignore and keep waiting until timeout.
        }
      } else if (this.connectPromise) {
        try {
          await this.connectPromise;
        } catch (_) {
          // Ignore and keep waiting until timeout.
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error("Timed out waiting for device");
  }

  async set_power(status) {
    const buffer = Buffer.from(
      `7e0404${status ? "01" : "00"}00${status ? "01" : "00"}ff00ef`,
      "hex"
    );
    return this.enqueueCommand("Power", buffer, () => {
      this.power = status;
    });
  }

  async set_brightness(level) {
    if (level > 100 || level < 0) return;
    const level_hex = ("0" + level.toString(16)).slice(-2);
    const buffer = Buffer.from(`7e0401${level_hex}ffffff00ef`, "hex");
    return this.enqueueCommand("Brightness", buffer, () => {
      this.brightness = level;
    });
  }

  async set_rgb(r, g, b) {
    const rhex = ("0" + r.toString(16)).slice(-2);
    const ghex = ("0" + g.toString(16)).slice(-2);
    const bhex = ("0" + b.toString(16)).slice(-2);
    const buffer = Buffer.from(`7e070503${rhex}${ghex}${bhex}10ef`, "hex");
    return this.enqueueCommand("Colour", buffer);
  }

  async set_hue(hue) {
    this.hue = hue;
    const rgb = hslToRgb(hue / 360, this.saturation / 100, this.l);
    return this.set_rgb(rgb[0], rgb[1], rgb[2]);
  }

  async set_saturation(saturation) {
    this.saturation = saturation;
    const rgb = hslToRgb(this.hue / 360, saturation / 100, this.l);
    return this.set_rgb(rgb[0], rgb[1], rgb[2]);
  }
};
