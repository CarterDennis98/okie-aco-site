import { uuid4 } from "@/lib/shikari/format";

/**
 * The phone a watchdog says it is.
 *
 * Every watchdog in a backup carries an `ios_device_data` blob -- model, iOS version, a
 * device id, a local-storage id, network interfaces, boot and install times -- and no two
 * share one: Shikari mints a new device for each task, so that Target sees several phones
 * watching rather than one phone asking very often.
 *
 * A watchdog the export adds (a list past 30 products) therefore copies an existing
 * watchdog's device and then re-rolls everything that identifies it -- ids, addresses,
 * times -- keeping the model and OS, which are only plausible as the combinations Shikari
 * itself produced. A backup with no watchdog to copy gets one of the combinations seen in
 * the reference backup.
 */

type Rng = () => number;

const between = (random: Rng, low: number, high: number) =>
  low + Math.floor(random() * (high - low + 1));
const pick = <T>(random: Rng, list: readonly T[]): T => list[Math.floor(random() * list.length)];

/** Model and OS pairs seen in real watchdogs. Only used when there is none to copy. */
const DEVICES = [
  { device_model: "iPhone18,4", ios_version: "26.5.1" },
  { device_model: "iPhone18,2", ios_version: "26.5.1" },
  { device_model: "iPhone16,2", ios_version: "26.5" },
  { device_model: "iPhone14,7", ios_version: "26.5" },
] as const;

const IPV6_INTERFACES = ["en0", "utun1", "en2", "llw0", "awdl0", "utun0"];

function linkLocalV6(random: Rng): string {
  const group = () => between(random, 0, 0xffff).toString(16);
  return `fe80::${group()}:${group()}:${group()}:${group()}`;
}

/** "169.254.141.169 : en2" -> the same kind of address on the same interface, re-rolled. */
function rerollV4(entry: string, random: Rng): string {
  const [ip, iface] = entry.split(" : ");
  const octets = ip.split(".");
  if (octets.length !== 4) return entry;
  if (ip.startsWith("169.254.")) {
    return `169.254.${between(random, 1, 254)}.${between(random, 1, 254)} : ${iface}`;
  }
  // A private LAN keeps its network and gets a new host.
  return `${octets.slice(0, 3).join(".")}.${between(random, 2, 254)} : ${iface}`;
}

function rerollV6(entry: string, random: Rng): string {
  const iface = entry.split(" : ")[1];
  return iface ? `${linkLocalV6(random)} : ${iface}` : entry;
}

export function freshDeviceData(
  template: unknown,
  random: Rng,
  now: Date,
): Record<string, unknown> {
  const base =
    template && typeof template === "object" && !Array.isArray(template)
      ? (template as Record<string, unknown>)
      : null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  // Booted a few days ago, and the app installed some time since -- the order the
  // reference backup's watchdogs all have.
  const boot = nowSeconds - between(random, 2 * 86400, 14 * 86400);
  const install = between(random, boot, nowSeconds - 3600);

  const v4 = Array.isArray(base?.ipv4_addresses)
    ? (base.ipv4_addresses as unknown[]).map((e) => rerollV4(String(e), random))
    : [
        `169.254.${between(random, 1, 254)}.${between(random, 1, 254)} : en2`,
        `192.168.1.${between(random, 2, 254)} : en0`,
      ];
  const v6 = Array.isArray(base?.ipv6_addresses)
    ? (base.ipv6_addresses as unknown[]).map((e) => rerollV6(String(e), random))
    : IPV6_INTERFACES.map((iface) => `${linkLocalV6(random)} : ${iface}`);

  const device = base ?? {
    ...pick(random, DEVICES),
    total_storage: pick(random, [256, 512, 1024]),
    user_interface_style: pick(random, ["Light", "Dark"]),
  };

  return {
    ...device,
    device_id: uuid4(random),
    gpu_registry_id: 4294967000 + between(random, 1, 999),
    ipv4_addresses: v4,
    ipv6_addresses: v6,
    local_storage_uuid: uuid4(random),
    boot_timestamp: boot,
    app_install_timestamp: install,
  };
}
