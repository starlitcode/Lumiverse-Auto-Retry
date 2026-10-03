// Garbled replies, against replies written the way a card actually writes them.
//
// A model that breaks down writes words from several languages run together,
// capitals in the middle of words, and scraps of other alphabets between
// English words. Each sign on its own turns up in good replies too, so the
// finished list here is the half that matters most: a reply re-rolled for one
// of those costs the reader the reply they were reading.
//
// Every example is made up for this file.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";

const { garbledVerdict, replyProblem } = __testing as any;
const cfg = { ...(__testing as any).CONFIG };

// Broken. Each of these must be caught.
const broken: Array<[string, string]> = [
  [
    "a whole reply gone to pieces",
    "harborQ lantern весь moved quietTRVS the keeper's 光线 window and harborline 门口 dust. " +
      "Tobias stood mapleKRN on the stair рука while gullFTH counted оно boatsWN in the slipway. " +
      "drift anchorPLX tideway 海边 roped and the pier сто leaned northLGT over the water где " +
      "barrelsQ stacked lanternmoss 灯塔 nightwatchVR crossingFRM and the gate opened onto nothing.",
  ],
  [
    "a good start that breaks down at the end",
    "Mirela set the kettle on the stove and waited for it to boil. Outside, the rain had eased, and the " +
      "street lamps came on one by one along the canal. She took two cups from the shelf and rinsed them " +
      "under the tap, then dried them on the cloth by the window. When Anselm came in, he hung his coat " +
      "on the hook and sat down at the table without a word. She poured the tea and pushed a cup toward " +
      "him. \"You look tired,\" she said. He nodded and wrapped both hands around the cup. " +
      "teacupLNT весь steamQ кухня windowFRS 灯 rainglassTV дом kettleRMB 窗户 copperPL нет ledgerWN " +
      "мост shelfQ 水 cloverNTB",
  ],
  [
    "Greek, Arabic and Devanagari scraps",
    "The caravan reached the wellQ at noon and the drivers καλά unloaded saltBRK from the camels. " +
      "dunesTRV merchant حسنا counted coinsFL while the boy साथ fetched waterJM from the trough. " +
      "Halvard walked the line ουρά checking ropesKN and the sun सूरज burned overheadPX through the haze " +
      "rugsQ spice بيت tentpoleWRB and the evening came cold over the sand.",
  ],
];

// Finished. None of these may be re-rolled.
const finished: Array<[string, string]> = [
  [
    "plain prose",
    "The council met in the long room above the granary. By noon the argument over the well had gone " +
      "round three times, and Marguerite waited at the end of the table for the others to tire. When the " +
      "miller finally stopped talking, she stood and laid a drawing of the pump on the table. The cracked " +
      "seal was marked in red ink. Old Barnaby traced it with his finger and grunted, and the vote was " +
      "taken before the bell rang for the midday meal.",
  ],
  [
    "Japanese honorifics and a quoted line",
    "Haruka bowed at the door of the shop. 「いらっしゃいませ」 she said, the way her mother always had, " +
      "and stepped aside to let Kenji-san in out of the rain. He shook the water from his umbrella and " +
      "looked along the shelves of tea tins, reading each label under his breath. \"The green one,\" he " +
      "said at last, and she wrapped it in paper and tied it with string while he counted out the coins " +
      "on the counter.",
  ],
  [
    "a character who speaks Russian",
    "Dmitri leaned against the railing and watched the ferry come in. \"Ну, наконец-то,\" he muttered. " +
      "\"Я ждал тебя два часа.\" Lena laughed and hoisted her bag onto her shoulder as she came down the " +
      "gangplank. \"The sea was rough,\" she said. \"Blame the captain, not me.\" He took the bag from her " +
      "without asking, and they walked together toward the line of taxis waiting along the quay in the " +
      "grey afternoon light.",
  ],
  [
    "product names",
    "Priya checked her iPhone again. Nothing from Marcus. She opened YouTube, closed it, and set the phone " +
      "face down beside her MacBook. The update for macOS had been running for an hour, and her iPad was " +
      "out of charge. On the shelf, her brother's PlayStation blinked its blue light. She gave up, walked " +
      "to the McDonald's on the corner, and ate her fries on a bench while LeBron's game played on the " +
      "screen in the window. iOS and macOS could wait until morning.",
  ],
  [
    "code with names in camel case",
    "Here is the fix. The handler was reading the wrong field:\n\n```js\nconst userName = getUserById(req.params.userId).displayNameRAW;\n" +
      "// 读取用户名\nfunction parseHTTPResponse(resXML) { return resXML.bodyTEXT; }\n```\n\nAfter that change the " +
      "name shows up correctly on the profile page, and the test for the empty case passes again. If the " +
      "field is missing, the function now returns an empty string instead of throwing, which matches what " +
      "the template expects when it renders the header.",
  ],
  [
    "a tracker in capitals",
    "The guards let them through the gate without a second look, and the market opened up in front of " +
      "them, loud and bright under the afternoon sun.\n\nHP: 42/50 | MP: 18/30 | GOLD: 112\nSTATUS: TIRED, " +
      "HUNGRY\nLOCATION: EASTGATE MARKET\nQUEST: FIND THE CARTOGRAPHER\n\nAsha pointed at a stall selling " +
      "maps. \"There,\" she said. \"Ask him about the old road north before the light goes.\"",
  ],
  [
    "a robot whose speech breaks up",
    "The unit's eyes flickered red. \"WaRnInG. SySTeM FaIlUrE. CoRe TeMpErAtUrE CrItIcAl,\" it said, " +
      "its voice skipping between pitches. Juno backed away from the console and grabbed the extinguisher " +
      "from the wall. The fans in the server room roared louder, and the lights along the ceiling dimmed " +
      "one after another. \"ShUtDoWn In TeN SeCoNdS,\" the unit went on, and then it was silent, and the " +
      "room was dark except for the glow of the emergency strip by the door.",
  ],
  [
    "physics in the scene",
    "Ines wrote the numbers on the board. If Δx is two metres and Δt is half a second, the speed is four " +
      "metres a second, she explained, and the class copied it down. Then she drew the α particle leaving " +
      "the nucleus and the β particle beside it, and marked the gap in μm. The students frowned at the " +
      "diagram. \"It is simpler than it looks,\" she said, and started again from the top with smaller " +
      "numbers so that everyone could follow along.",
  ],
  [
    "a reply in Chinese with English words",
    "她打开MacBook，看了看YouTube上的视频，然后把iPhone放在桌子上。窗外下着雨，街上的灯一盏一盏地亮了起来。" +
      "她给Marcus发了一条消息，说明天早上八点在café门口见面。过了一会儿，他回复说好的，还加了一个笑脸。" +
      "她笑了笑，关上电脑，去厨房烧水泡茶。",
  ],
  [
    "names with accents",
    "Zoë and Søren met Beyoncé's cousin at the café on Rue Saint-Étienne. The waiter brought crêpes and " +
      "two cups of chocolate. Søren talked about Ångström and the old laboratory in Uppsala, and Zoë " +
      "listened with her chin on her hand while the rain ran down the window behind her. When the bill " +
      "came, they split it three ways and walked back along the river together in the dark.",
  ],
];

describe("garbled replies are caught", () => {
  for (const [name, text] of broken) {
    test(name, () => {
      expect(garbledVerdict(text)).toBe(true);
    });
  }
});

describe("good replies are left alone", () => {
  for (const [name, text] of finished) {
    test(name, () => {
      expect(garbledVerdict(text)).toBe(false);
    });
  }
});

describe("it is a reason to retry", () => {
  test("replyProblem calls it garbled", () => {
    expect(replyProblem(broken[0][1], "", { ...cfg, retryOnGarbled: true })).toBe("garbled");
  });
  test("and the switch turns it off", () => {
    expect(replyProblem(broken[0][1], "", { ...cfg, retryOnGarbled: false })).not.toBe("garbled");
  });
  test("thinking before a garbled reply does not hide it", () => {
    expect(replyProblem("<think>Plan the scene.</think>\n" + broken[0][1], "", { ...cfg, retryOnGarbled: true })).toBe("garbled");
  });
  test("it is on by default", () => {
    expect(cfg.retryOnGarbled).toBe(true);
  });
});
