import { activityKey } from "./camera-activity.mjs";

/** Reuses HA's broker connection; credentials never leave HA. State expires on loss. */
export class ActivityMqtt {
  constructor({
    ha,
    activity,
    registry,
    now = Date.now,
    shutdownTimeoutMs = 3000,
  }) {
    Object.assign(this, { ha, activity, registry, now, shutdownTimeoutMs });
    this.sent = new Map();
    this.discovery = new Map();
  }
  reset() {
    this.sent.clear();
    this.discovery.clear();
    this.supported = undefined;
  }
  async publish(topic, payload, retain = false) {
    await this.ha.request({
      type: "call_service",
      domain: "mqtt",
      service: "publish",
      service_data: { topic, payload: JSON.stringify(payload), qos: 1, retain },
    });
  }
  tick() {
    if (this.stopped || this.inFlight || !this.ha.connected)
      return Promise.resolve();
    const running = this.runTick();
    this.inFlight = running;
    return running.finally(() => {
      if (this.inFlight === running) this.inFlight = undefined;
    });
  }
  async runTick() {
    try {
      if (
        this.supported === undefined ||
        this.now() - (this.checkedAt ?? 0) > 60000
      ) {
        const services = await this.ha.request({ type: "get_services" });
        this.supported = Boolean(services.mqtt?.publish);
        this.checkedAt = this.now();
      }
      if (this.stopped || !this.supported) return;
      const registry = this.registry();
      for (const camera of registry.cameras) {
        if (this.stopped) return;
        const key = activityKey(camera.id),
          topic = `haus/activity/${key}/state`;
        const area = registry.areas?.find(
          (area) => area.area_id === camera.areaId,
        )?.name;
        const discovery = {
          name: null,
          unique_id: key,
          default_entity_id: `binary_sensor.${camera.id.slice(7)}_activity`,
          device_class: "motion",
          state_topic: topic,
          value_template: "{{ value_json.state }}",
          json_attributes_topic: topic,
          json_attributes_template: "{{ value_json.attributes | tojson }}",
          availability_topic: topic,
          availability_template: "{{ value_json.availability }}",
          expire_after: 45,
          device: {
            // HA omits extra state attributes while unavailable. Keep the
            // camera relationship in the persistent device registry too.
            identifiers: [key, `haus_camera:${camera.id}`],
            name: `${camera.name} Activity`,
            manufacturer: "Haus",
            model: "Unified camera activity",
            ...(area ? { suggested_area: area } : {}),
          },
          origin: {
            name: "Haus",
            support_url: "https://github.com/resonaura/haus-helper",
          },
        };
        const encoded = JSON.stringify(discovery);
        if (this.discovery.get(key) !== encoded) {
          await this.publish(
            `homeassistant/binary_sensor/${key}/config`,
            discovery,
            true,
          );
          this.discovery.set(key, encoded);
        }
        if (this.stopped) return;
        const status = this.activity.status(camera.id);
        const payload = {
          state: status.active ? "ON" : "OFF",
          availability: status.available ? "online" : "offline",
          attributes: {
            haus_activity_version: 1,
            haus_camera: camera.id,
            native_sources: status.replaces ?? [],
            linked_sources: status.sources ?? [],
            source: status.source,
            assist_state: status.assistState ?? "off",
          },
        };
        const previous = this.sent.get(key),
          value = JSON.stringify(payload);
        if (
          !previous ||
          value !== previous.value ||
          this.now() - previous.at >= 15000
        ) {
          // No retained state: a restarted HA must wait for a fresh live observation.
          await this.publish(topic, payload);
          this.sent.set(key, { value, at: this.now() });
        }
      }
    } catch {
      // Broker failure does not disable recording or trigger any camera action.
      this.discovery.clear();
    }
  }
  async stop() {
    this.stopped = true;
    const cleanup = async () => {
      // An already sent online observation must settle before the final offline
      // message. No subsequent tick may resurrect a stopped publisher.
      await this.inFlight?.catch(() => {});
      await Promise.all(
        this.registry().cameras.map(async (camera) => {
          const key = activityKey(camera.id);
          if (this.sent.has(key))
            await this.publish(`haus/activity/${key}/state`, {
              state: "OFF",
              availability: "offline",
              attributes: { haus_activity_version: 1, haus_camera: camera.id },
            }).catch(() => {});
        }),
      );
    };
    let timer;
    try {
      // A broken HA/broker connection cannot hold up recorder shutdown. The
      // non-retained state also expires in HA if offline cannot be delivered.
      await Promise.race([
        cleanup(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.shutdownTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
