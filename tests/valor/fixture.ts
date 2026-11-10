/**
 * A small, synthetic Valor backup, shaped like the operator's real two instances (read
 * 2026-11-10) -- not their data: every name, card and password here is made up.
 *
 *   Profile groups   "PKC Personal"  the operator's own, kept by hand: never touched
 *                    "ACO Main"      alice - 1, bob - 1, carol - 1
 *                    "ACO Backup"    alice - 6, bob - 6
 *                    "Target"        alice - 1 (Target's), dave - 1, erin - 1
 *                    "Walmart"       one profile, another site's
 *   Task groups      "PKC Personal - ISP"       the personal profile's
 *                    "PKC ACO - ISP"            one per ACO Main profile, on "PKC ISP"
 *                    "PKC ACO - Resi"           one per ACO Main profile, on "PKC Resi"
 *                    "PKC ACO (backup) - Resi"  one per ACO Backup profile, on "PKC Resi"
 *                    "Target"                   dave - 1's and erin - 1's, on "Target ISP",
 *                                               one still running from the operator's test
 *                    "Walmart"                  one task, another site's
 *   Logins           "Target": dave's (signed in) and erin's; "Walmart": one
 *   IMAP             dave's own inbox, a catch-all, and one nothing here uses
 *
 * `vaultOf` reads it back as the vault would hold it, so a build from that is a no-op.
 */
import type { ValorBackup, ValorProfile, ValorTask } from "@/lib/valor/format";
import type {
  DesiredMiscProfile,
  DesiredValorInstance,
  DesiredValorProfile,
} from "@/lib/valor/types";

export const IDS = {
  personal: "g-personal",
  main: "g-aco-main",
  backup: "g-aco-backup",
  target: "g-target",
  walmart: "g-walmart",
  personalTasks: "t-personal-isp",
  isp: "t-pkc-isp",
  resi: "t-pkc-resi",
  backupResi: "t-pkc-backup-resi",
  targetTasks: "t-target",
  walmartTasks: "t-walmart",
  targetLogins: "a-target",
  walmartLogins: "a-walmart",
  pkcIsp: "x-pkc-isp",
  pkcResi: "x-pkc-resi",
  targetIsp: "x-target-isp",
  mobile: "x-mobile",
};

const address = (first: string, street: string) => ({
  firstName: first,
  lastName: "Tester",
  addressLine1: street,
  addressLine2: "",
  city: "Oklahoma City",
  countryName: "United States",
  countryCode: "US",
  state: "Oklahoma",
  zipCode: "73170",
});

export function profile(
  id: string,
  name: string,
  email: string,
  opts: { phone?: string; card?: string; billing?: string; oneCheckout?: boolean } = {},
): ValorProfile {
  const first = name.split(" ")[0].replace(/^./, (c) => c.toUpperCase());
  const shipping = address(first, `${id.length} Main St`);
  const billing = opts.billing ? address(first, opts.billing) : { ...shipping };
  return {
    name,
    email,
    phoneNumber: opts.phone ?? "405-555-0101",
    billingSameAsShipping: !opts.billing,
    oneCheckout: opts.oneCheckout ?? false,
    quickTask: false,
    card: {
      holder: `${first} Tester`,
      number: opts.card ?? "4111 1111 1111 1111",
      expiration: "09/31",
      cvv: "123",
      type: opts.card?.startsWith("37") ? "amex" : "visa",
    },
    shipping,
    billing,
    id,
    totalSpent: 0,
  };
}

function task(
  id: string,
  profileId: string,
  profileName: string,
  profileGroupID: string,
  proxyGroupID: string,
  over: Partial<ValorTask> = {},
): ValorTask {
  return {
    id,
    selected: false,
    running: false,
    status: "Idle",
    color: "neutral",
    queueTime: -1,
    carted: false,
    successful: false,
    failed: false,
    passedQueue: false,
    currentProxy: null,
    type: null,
    mode: "Default",
    proxyGroupID,
    queueProxyGroupID: null,
    monitorProxyGroupID: null,
    profile: { name: profileName, id: profileId },
    profileGroupID,
    accountGroupID: null,
    account: null,
    products: [
      {
        sizeRange: [],
        displayedItem: "placeholder",
        displayedSize: "",
        monitorInput: "placeholder",
        color: "",
        minSizesLoaded: 0,
        minPrice: 0,
        maxPrice: null,
        productQuantity: 1,
        skipIfOOS: true,
      },
    ],
    monitorDelay: 3500,
    retryDelay: 3500,
    config: { startOnQueue: true, loopCheckout: true, maxQueueTime: 90 },
    isAutomationTask: false,
    startScheduleTime: null,
    stopScheduleTime: null,
    ...over,
  };
}

const map = <T extends { id: string }>(items: T[]) =>
  Object.fromEntries(items.map((i) => [i.id, i]));

function taskGroup(id: string, name: string, siteModule: string, count: number) {
  return {
    id,
    name,
    totalAmount: count,
    monitorID: null,
    selected: false,
    siteModule,
    site: siteModule === "PokemonCenter" ? "Pokemon Center US" : siteModule,
    selectedCategories: [false, false, false, false],
    displayedTaskType: null,
    taskCounts: { Default: count },
  };
}

export function valorBackup(): ValorBackup {
  const main = [
    profile("p-alice-1", "alice - 1", "alice1@example.com"),
    profile("p-bob-1", "bob - 1", "bob1@example.com", { phone: "0", billing: "9 Bill Rd" }),
    profile("p-carol-1", "carol - 1", "carol1@example.com", { card: "3782 822463 10005" }),
  ];
  const backup = [
    profile("p-alice-6", "alice - 6", "alice6@example.com", { oneCheckout: true }),
    profile("p-bob-6", "bob - 6", "bob6@example.com", { phone: "0" }),
  ];
  const target = [
    profile("p-t-alice-1", "alice - 1", "alice1@example.com"),
    profile("p-t-dave-1", "dave - 1", "dave1@example.com"),
    profile("p-t-erin-1", "erin - 1", "erin1@example.com"),
  ];
  const personal = [profile("p-pkc-1", "PKC 1", "house1@example.com")];
  const walmart = [profile("p-w-1", "Walmart alice #1", "alice1@example.com")];

  const isp = main.map((p, i) => task(`k-isp-${i}`, p.id, p.name, IDS.main, IDS.pkcIsp));
  const resi = main.map((p, i) => task(`k-resi-${i}`, p.id, p.name, IDS.main, IDS.pkcResi));
  const backupResi = backup.map((p, i) =>
    task(`k-bresi-${i}`, p.id, p.name, IDS.backup, IDS.pkcResi),
  );
  const personalTasks = [task("k-personal", "p-pkc-1", "PKC 1", IDS.personal, IDS.pkcIsp)];
  const targetTask = (
    id: string,
    p: ValorProfile,
    account: string,
    over: Partial<ValorTask> = {},
  ) =>
    task(id, p.id, p.name, IDS.target, IDS.targetIsp, {
      monitorProxyGroupID: IDS.targetIsp,
      accountGroupID: IDS.targetLogins,
      account: { name: p.email, id: account },
      config: { startOnQueue: false, loopCheckout: false, maxQueueTime: 90 },
      products: [
        {
          sizeRange: [],
          displayedItem: "placeholder",
          displayedSize: "",
          monitorInput: "placeholder",
          color: "",
          minSizesLoaded: 0,
          minPrice: 0,
          maxPrice: null,
          productQuantity: 3,
          skipIfOOS: false,
        },
      ],
      ...over,
    });
  const targetTasks = [
    targetTask("k-t-dave", target[1], "l-dave", {
      running: true,
      selected: true,
      status: "Waiting For Shape...",
      color: "yellow",
      currentProxy: "10.0.0.1:8000:user:pass",
    }),
    targetTask("k-t-erin", target[2], "l-erin"),
  ];
  const walmartTasks = [
    task("k-w-1", "p-w-1", "Walmart alice #1", IDS.walmart, IDS.mobile, {
      accountGroupID: IDS.walmartLogins,
      account: { name: "alice1@example.com", id: "l-w-1" },
    }),
  ];

  return {
    version: "3.0",
    tasks: {
      groups: map([
        taskGroup(IDS.personalTasks, "PKC Personal - ISP", "PokemonCenter", 1),
        taskGroup(IDS.isp, "PKC ACO - ISP", "PokemonCenter", 3),
        taskGroup(IDS.resi, "PKC ACO - Resi", "PokemonCenter", 3),
        taskGroup(IDS.backupResi, "PKC ACO (backup) - Resi", "PokemonCenter", 2),
        { ...taskGroup(IDS.targetTasks, "Target", "Target", 2), selected: true },
        taskGroup(IDS.walmartTasks, "Walmart", "Walmart", 1),
      ]),
      lists: {
        [IDS.personalTasks]: { Default: map(personalTasks) },
        [IDS.isp]: { Default: map(isp) },
        [IDS.resi]: { Default: map(resi) },
        [IDS.backupResi]: { Default: map(backupResi) },
        [IDS.targetTasks]: { Default: map(targetTasks) },
        [IDS.walmartTasks]: { Default: map(walmartTasks) },
      },
    },
    proxies: {
      groups: map([
        { id: IDS.pkcIsp, name: "PKC ISP", totalAmount: 1 },
        { id: IDS.pkcResi, name: "PKC Resi", totalAmount: 1 },
        { id: IDS.targetIsp, name: "Target ISP", totalAmount: 2 },
        { id: IDS.mobile, name: "Mobile", totalAmount: 1 },
      ]),
      lists: {
        [IDS.pkcIsp]: [{ proxy: "10.0.0.1:8000:u:p", status: "", color: "", selected: false }],
        [IDS.pkcResi]: [
          { proxy: "resi.example.net:7777:u:p", status: "", color: "", selected: false },
        ],
        [IDS.targetIsp]: [
          { proxy: "10.0.1.1:8000:u:p", status: "", color: "", selected: false },
          { proxy: "10.0.1.2:8000:u:p", status: "", color: "", selected: false },
        ],
        [IDS.mobile]: [{ proxy: "m.example.net:9000:u:p", status: "", color: "", selected: false }],
      },
    },
    accounts: {
      groups: map([
        { id: IDS.targetLogins, name: "Target", totalAmount: 2, site: "Target" },
        { id: IDS.walmartLogins, name: "Walmart", totalAmount: 1, site: "Walmart US" },
      ]),
      lists: {
        [IDS.targetLogins]: map([
          {
            id: "l-dave",
            email: "dave1@example.com",
            password: "dave-old-pass",
            proxy: null,
            session: true,
            selected: true,
          },
          {
            id: "l-erin",
            email: "erin1@example.com",
            password: "erin-pass",
            proxy: null,
            session: false,
            selected: false,
          },
        ]),
        [IDS.walmartLogins]: map([
          {
            id: "l-w-1",
            email: "alice1@example.com",
            password: "walmart-pass",
            proxy: null,
            session: false,
            selected: false,
          },
        ]),
      },
    },
    profiles: {
      groups: map([
        { id: IDS.personal, name: "PKC Personal", totalAmount: 1 },
        { id: IDS.main, name: "ACO Main", totalAmount: 3 },
        { id: IDS.backup, name: "ACO Backup", totalAmount: 2 },
        { id: IDS.target, name: "Target", totalAmount: 3 },
        { id: IDS.walmart, name: "Walmart", totalAmount: 1 },
      ]),
      lists: {
        [IDS.personal]: map(personal),
        [IDS.main]: map(main),
        [IDS.backup]: map(backup),
        [IDS.target]: map(target),
        [IDS.walmart]: map(walmart),
      },
    },
    settings: { userKey: "VALOR-TEST-KEY", maxConcurrentBrowsers: 10, windowPositions: {} },
    captchaHarvesters: { harvesters: {}, cookies: {} },
    captchaProviders: {},
    imap: map([
      {
        id: "m-dave",
        server: "imap.gmail.com",
        email: "dave1@example.com",
        password: "dave-app",
        readEmails: 2,
        codesReceived: 1,
        connected: true,
        enabled: true,
        selected: false,
        status: "Waiting For Emails",
      },
      {
        id: "m-catchall",
        server: "imap.gmail.com",
        email: "catchall@example.com",
        password: "catch-app",
        readEmails: 0,
        codesReceived: 0,
        connected: true,
        enabled: true,
        selected: false,
        status: "Waiting For Emails",
      },
      {
        id: "m-unused",
        server: "imap.mail.yahoo.com",
        email: "unused@example.com",
        password: "unused-app",
        readEmails: 0,
        codesReceived: 0,
        connected: false,
        enabled: true,
        selected: false,
        status: "Login Error: Invalid credentials",
      },
    ]),
    automations: { groups: {}, lists: {} },
  };
}

/** A Valor profile as the vault holds it: the inverse of the export's conversion. */
export function vaultOf(
  p: ValorProfile,
  owner = p.name.replace(/\s*-\s*\d+$/, ""),
): DesiredValorProfile {
  const codes = { Oklahoma: "OK" } as Record<string, string>;
  const addr = (a: ValorProfile["shipping"]) => ({
    firstName: a.firstName,
    lastName: a.lastName,
    street: a.addressLine1,
    street2: a.addressLine2,
    city: a.city,
    state: codes[a.state] ?? a.state,
    zip: a.zipCode,
    country: a.countryCode,
  });
  const [month, year] = p.card.expiration.split("/");
  return {
    key: `vault-${p.id}`,
    ownerId: owner,
    ownerName: owner,
    name: p.name,
    email: p.email,
    phone: p.phoneNumber === "0" ? "0" : p.phoneNumber.replace(/\D/g, ""),
    shipping: addr(p.shipping),
    billing: p.billingSameAsShipping ? null : addr(p.billing),
    card: {
      number: p.card.number.replace(/\D/g, ""),
      expMonth: month,
      expYear: `20${year}`,
      cvv: p.card.cvv,
    },
    onlyCheckoutOnce: p.oneCheckout,
  };
}

/** The fixture's own ACO profiles as the vault would send them, for an instance with no misc line. */
export function desiredInstance(
  b: ValorBackup = valorBackup(),
  misc: DesiredMiscProfile[] | null = null,
): DesiredValorInstance {
  const main = Object.values(b.profiles.lists[IDS.main]).map((p) => vaultOf(p));
  const backup = Object.values(b.profiles.lists[IDS.backup]).map((p) => vaultOf(p));
  return {
    position: misc ? 2 : 1,
    main,
    backup,
    misc,
    products: [
      { sku: "91000001", name: "Product One" },
      { sku: "91000002", name: "Product Two" },
      { sku: "91000003", name: "Product Three" },
    ],
    known: [...main, ...backup].map((d) => ({
      site: "pkc" as const,
      name: d.name,
      email: d.email,
      why: null,
    })),
  };
}

/** A Target picker from the fixture's Target group, picking `products`. */
export function picker(
  b: ValorBackup,
  id: string,
  products: { sku: string; qty: number }[],
  over: Partial<DesiredMiscProfile> = {},
): DesiredMiscProfile {
  return {
    ...vaultOf(b.profiles.lists[IDS.target][id]),
    password: "new-pass",
    mailbox: null,
    products,
    ...over,
  };
}

/** Deterministic ids: "00000000-0000-4000-8000-000000000001" and on. */
export function sequence(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`;
}
