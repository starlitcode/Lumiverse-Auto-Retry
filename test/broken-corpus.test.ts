// Broken replies of the kinds a model writes when it falls apart, against
// replies a character writes on purpose that look close to them.
//
// Each check has a list it must catch and a list it must leave alone. A reply
// re-rolled by mistake costs the reader the reply they were reading, so the
// second list matters as much as the first.
//
// Every example is made up for this file.
//
// Run with: bun test

import { expect, test, describe } from "bun:test";
import { __testing } from "../src/frontend";

const { soupVerdict, switchVerdict, gluedVerdict, leakVerdict, loopVerdict, garbledVerdict, replyProblem } = __testing as any;
const cfg = { ...(__testing as any).CONFIG };

const scene =
  "Tamsin pulled the cart into the lee of the barn and climbed down. The mule shook the rain from its ears and " +
  "stood with its head low. Inside, the lamp was already lit, and Orrin sat by the stove mending a strap with " +
  "an awl and a length of waxed thread. He looked up when the door opened, then went back to his work. " +
  "\"You took the long road,\" he said. \"The bridge was out,\" she answered, and hung her coat on the peg. ";

describe("broken characters", () => {
  const broken: Array<[string, string]> = [
    [
      "text read with the wrong encoding",
      scene +
        "She said itâ€™s fine, the cafÃ© was closed, Ã¢â‚¬Å“weâ€™ll go tomorrowâ€\u009d, and the rÃ©sumÃ© " +
        "lay on the table beside the Ã©clair and the piÃ±ata, and nobody knew whatâ€™s next.",
    ],
    ["replacement characters and control characters", scene + "��\u0001 the �� lamp \u0002���\u0003 went �� out."],
    [
      "a tokenizer's marks for a space and a line break printed as text",
      scene +
        "He\u0120set\u0120the\u0120cup\u0120down.\u010A\"Fine.\"\u0120She\u0120turned\u0120to\u0120the\u0120window\u0120and\u0120waited.\u010A" +
        "The\u0120rain\u0120kept\u0120on.",
    ],
  ];
  const fine: Array<[string, string]> = [
    ["one slip in a reply that reads", scene + "She said itâ€™s fine."],
    ["French with its accents", scene + "\"Très bien, à demain,\" said Élodie. \"Ça va? Le café était déjà fermé.\""],
    ["Spanish punctuation", scene + "\"¿Dónde está el señor?\" asked Inés. \"¡Allí, junto a la puerta!\""],
    ["a redacted file", scene + "The report read: Subject ████████ was moved to ██████ on the third night."],
    [
      "Maltese, which writes \u0120 and \u010A as letters at the start of a word",
      "Il-\u0120imgħa li għaddiet \u0120ejt id-dar. \"\u010Airasa u \u0120obon,\" qalet. Il-\u0120urnata kienet sabiħa (\u010Aertament). ".repeat(4),
    ],
  ];
  for (const [label, text] of broken) test("caught: " + label, () => expect(soupVerdict(text)).toBe(true));
  for (const [label, text] of fine) test("left alone: " + label, () => expect(soupVerdict(text)).toBe(false));
});

describe("a switch to another alphabet for the rest of the reply", () => {
  const russianTail =
    "Затем дорога ушла вниз к реке, и никто не знал, куда идти дальше, потому что мост был сломан и вода поднималась.";
  const chineseTail = "然后道路向下延伸到河边，没有人知道该往哪里走，因为桥已经断了，水还在不断上涨，天也越来越黑。";
  test("caught: English that turns into Russian and never comes back", () => {
    expect(switchVerdict(scene + scene + russianTail)).toBe(true);
  });
  test("caught: English that turns into Chinese and never comes back", () => {
    expect(switchVerdict(scene + scene + chineseTail + chineseTail)).toBe(true);
  });
  test("left alone: the same words said by a character, in quotation marks", () => {
    expect(switchVerdict(scene + scene + "She whispered, \"" + russianTail + "\"")).toBe(false);
  });
  test("left alone: a line in Russian with English after it", () => {
    expect(switchVerdict(scene + russianTail + " " + scene)).toBe(false);
  });
  test("left alone: a reply written in Russian from the start", () => {
    expect(switchVerdict(russianTail + " " + russianTail + " " + russianTail)).toBe(false);
  });
  test("left alone: a short phrase at the end", () => {
    expect(switchVerdict(scene + scene + "Спасибо, друг.")).toBe(false);
  });
  test("left alone: a letter in Russian after a colon", () => {
    expect(switchVerdict(scene + scene + "She unfolded the note. It read:\n\n" + russianTail)).toBe(false);
  });
  test("left alone: a passage in Russian set in italics", () => {
    expect(switchVerdict(scene + scene + "He sang under his breath. *" + russianTail)).toBe(false);
  });
  test("left alone: a passage in Russian in a quoted block", () => {
    expect(switchVerdict(scene + scene + "\n> " + russianTail)).toBe(false);
  });
});

describe("words run together with no spaces", () => {
  const broken: Array<[string, string]> = [
    [
      "narration that drops its spaces",
      scene +
        "*Tamsin'sshouldersloosenedalittle,butshekeptherfacestill.* She stood. Hethoughtaboutthebridgeandtheriverthatnight " +
        "and saidnothingatallforthelongestwhile.",
    ],
    [
      "a short reply that falls apart into joined words",
      "\"Fine, I only wanted to go home as fast aspossibly can, lol . ... ughfinewhateverOrrinpal. Vessa ko Orrin " +
        "laterdriftedwantedtoanswerramsleevesat2nd, he ffornelved rider the khin pon ei unmaking oxvlet " +
        "Ebrandat QRTloomsal)- !! ` \" n .\"T vrnumber Wrongreturnedsfasde le corridera)' sankfistem leaningpath tor",
    ],
  ];
  const fine: Array<[string, string]> = [
    ["one long word in a good reply", scene + "It was, she said, uncharacteristically quiet for a market day, and disproportionately cold."],
    ["a well-known long word", scene + "\"Supercalifragilisticexpialidocious,\" Orrin sang, badly, and Tamsin threw a glove at him."],
    ["a scream held long", scene + "\"Noooooooooooooooooooooooooooooooooooooooooo!\" and then \"Ahhhhhhhhhhhhhhhhhhhhhhhhhhhhh!\""],
    ["a keysmash in a text message", scene + "Her phone buzzed: asdfghjkasdfgjhkasdfgh and sdkjfhsdkjfhskdjfh lol."],
    ["web addresses, hashtags and handles", scene + "See https://example.com/averylongpathwithoutanyspacesinit and #averylonghashtagwithnospaces from @averylongusernamehereforsure."],
    ["one text message written with no spaces", scene + "It read: iamsorryicouldnotfindyouanywhere. She put the phone away."],
    [
      "a reply in German with long words",
      ("Die Kraftfahrzeughaftpflichtversicherung war teuer, sagte sie leise. Er nickte nur und las die Liste der " +
        "Rechtsschutzversicherungsgesellschaften noch einmal durch, bevor er den Brief faltete. Draussen fuhr die " +
        "Strassenbahn vorbei, und die Donaudampfschifffahrtsgesellschaft hatte wieder geschrieben. ").repeat(2),
    ],
    [
      "a reply in Dutch with long words",
      ("De Arbeidsongeschiktheidsverzekering was duur, zei ze zacht. Hij knikte en las de Kinderbijslagvoorzieningen " +
        "nog een keer door. Buiten reed de tram voorbij en de Hoogspanningsverbindingen zoemden. ").repeat(3),
    ],
  ];
  for (const [label, text] of broken) test("caught: " + label, () => expect(gluedVerdict(text)).toBe(true));
  for (const [label, text] of fine) test("left alone: " + label, () => expect(gluedVerdict(text)).toBe(false));
});

describe("the thinking, judged on its own", () => {
  const plan =
    "The reader wants Tamsin to answer Orrin about the bridge. Keep it short and dry. She is tired, so no long speech. " +
    "Mention the coat on the peg, and leave the strap for him to bring up. ";
  const reply = "\"It was out,\" Tamsin said, and sat down by the stove. Orrin went on with the strap.";
  const jumble =
    "然后system拒绝了道路data处理 cartQ 心理model训练集准确率 lampFRS 桥已经断了 stoveTL 没有人知道 strap路径 " +
    "awlRMB 数据集验证结果为 barnLWN 他们的mapping继续 muleQ 水还在不断上涨 pegTRV 天也越来越黑 coatFRN 结果 ";
  const loop = plan + "Wait, let me check the bridge again. ".repeat(14);
  const caught: Array<[string, string, string, string]> = [
    ["garbled thinking sent apart from the reply", reply, plan + plan + jumble.repeat(3), "thinking was garbled"],
    ["garbled thinking written into the reply", "<think>" + plan + plan + jumble.repeat(3) + "</think>\n\n" + reply, "", "thinking was garbled"],
    ["thinking with words run together", reply, plan + "Shewantstoanswerhimabouttheriverquickly and thenmaybementionthecoatonthepegafter, ok.", "thinking was garbled"],
    ["thinking stuck repeating to its end, sent apart", reply, loop, "thinking got stuck repeating"],
    ["thinking stuck repeating to its end, written into the reply", "<think>" + loop + "</think>\n\n" + reply, "", "thinking got stuck repeating"],
    [
      "thinking that cycles through a few sentences and breaks out",
      reply,
      plan + "I should write the reply. I should write it now. Write it.\n".repeat(9) + "Fine. Tamsin answers and sits by the stove.",
      "thinking got stuck repeating",
    ],
    [
      "a loop after a draft of the reply's first line, written into the reply",
      "<think>" + plan + "Draft: " + reply + " " + "Wait, let me check the bridge again. ".repeat(14) + "</think>\n\n" + reply,
      "",
      "thinking got stuck repeating",
    ],
  ];
  const fine: Array<[string, string, string]> = [
    ["thinking in Chinese from the start", reply, "读者希望塔姆辛回答关于桥的问题。保持简短，语气干脆。她很累，所以不要长篇大论。提到挂在钉子上的外套。".repeat(4)],
    ["thinking that switches to Chinese partway", reply, plan + plan + "然后我想一想，她应该怎么回答这个问题，保持简短，语气干脆，不要太长，提到外套。".repeat(2)],
    ["thinking that says the same thing a few times and goes on", reply, plan + "Wait, let me check. ".repeat(4) + plan],
    [
      "a long plan with no punctuation",
      reply,
      Array.from({ length: 170 }, (_, i) => ["keep", "her", "voice", "short", "and", "tired", "then", "the", "coat", "goes", "on", "a", "peg", "by", "door"][i % 15] + (i % 4 ? "" : "s")).join(" "),
    ],
    ["a reply whose first line is drafted in the thinking", reply, plan + "Draft: \"It was out,\" Tamsin said, and sat down by the stove. Good."],
  ];
  for (const [label, content, thought, why] of caught)
    test("caught: " + label, () => expect(replyProblem(content, thought, cfg)).toBe(why));
  for (const [label, content, thought] of fine)
    test("left alone: " + label, () => expect(replyProblem(content, thought, cfg)).toBe(""));
  test("each has its own switch", () => {
    expect(replyProblem(reply, plan + plan + jumble.repeat(3), { ...cfg, retryOnGarbledThinking: false })).toBe("");
    expect(replyProblem(reply, loop, { ...cfg, retryOnLoopThinking: false })).toBe("");
  });
  test("and both are on by default", () => expect(cfg.retryOnGarbledThinking && cfg.retryOnLoopThinking).toBe(true));
});

describe("the prompt's format leaked into the reply", () => {
  const broken: Array<[string, string]> = [
    ["an instruction marker and card data", scene + "Here. [/INST] [Character(\"Pell\")][Occupation(\"miller\")] Backstory: Pell grew up by the weir."],
    ["a system marker", scene + "<<SYS>> You are Pell, a miller who speaks little. <</SYS>>"],
    ["an Alpaca heading", scene + "\n\n### Instruction:\nContinue the story as Pell."],
    ["the next turn started by the model", scene + "<|im_start|>user\nI take the strap from him."],
    ["two lines of card data", scene + "[Name(\"Pell\")] [Mind(\"patient\" + \"wry\")] and then the weir."],
    ["card data running on after the story", scene + "\n\n[Character(\"Pell\")]\n[Occupation(\"miller\")]"],
    ["an instruction marker after a colon and another after the story", "The format is: [INST] words [/INST]\n\n" + scene + "[/INST] and the weir."],
  ];
  const fine: Array<[string, string]> = [
    ["a tracker in brackets", scene + "[Health: 8/10] [Mood: tired] [Location: the barn]"],
    ["one bracketed line that looks like code", scene + "On the slate he had chalked [Order(\"flour\")] and nothing else."],
    ["the markers inside a code block", scene + "\n```\n[INST] example [/INST]\n<<SYS>>\n```\n"],
    ["a turn marker that opens the reply", "<|im_start|>assistant\n" + scene],
    ["a heading that is part of the story", scene + "\n\n### Chapter Two\nThe weir was quiet."],
    // An assistant asked to write a character card, or to explain a format.
    ["a character card the reply was asked to write", "[Character(\"Pell\")]\n[Occupation(\"miller\")]\n[Mind(\"patient\" + \"wry\")]\n[Likes(\"quiet water\")]"],
    ["a character card after a colon", "Sure. Here is the card for Pell:\n\n[Character(\"Pell\")]\n[Occupation(\"miller\")]\n[Mind(\"patient\")]"],
    ["an instruction template after a colon", "The template looks like this:\n### Instruction:\nWrite the next scene.\n### Response:"],
    ["an instruction marker explained after a colon", "Llama 2 wraps your turn like this: [INST] your words go here [/INST]"],
  ];
  for (const [label, text] of broken) test("caught: " + label, () => expect(leakVerdict(text, cfg)).toBe(true));
  for (const [label, text] of fine) test("left alone: " + label, () => expect(leakVerdict(text, cfg)).toBe(false));
});

describe("stuck repeating or rambling", () => {
  const runOn = Array.from({ length: 170 }, (_, i) => ["quiet", "still", "settled", "calm", "resting", "steady", "level", "even"][i % 8] + (i % 3 ? "" : "ly")).join(" ");
  const broken: Array<[string, string]> = [
    ["a phrase repeated to the end", scene + "the lantern is the lantern is ".repeat(14) + "the lan"],
    ["one word repeated to the end", scene + "Not here, here, " + "here, ".repeat(80)],
    ["a sentence repeated to the end", scene + "She looked at the door and waited for him. ".repeat(12)],
    ["a short pattern repeated hundreds of times", scene + "The total was 3." + "1.".repeat(120) + " as a fraction."],
    ["words running on with no punctuation to the end", scene + runOn],
    ["a loop inside dialogue that never closes", scene + "\"I do not know, " + "I do not know, ".repeat(25)],
    ["a loop inside asterisks that never close", scene + "*She ran and " + "she ran and ".repeat(25)],
    ["a pattern of digits after a colon", scene + "The total was: " + "1.".repeat(120)],
    ["one word and a comma repeated to the end", scene + "The tired, hopeful, small, " + "and, ".repeat(40) + "and,"],
    [
      "one sentence six times, then another six times, with the scene going on",
      scene + "The stove ticks as it cools. ".repeat(6) + "Orrin pulls the strap tight. ".repeat(6) + "Then the lamp went out.",
    ],
    ["two sentences in turn, over and over", scene + "Tamsin looks at the door. The wind pulls at the shutters. ".repeat(6) + "Nobody came."],
    [
      "three sentences in turn, with an odd one between, that break off",
      scene + "Orrin waits by the stove.\nHe says nothing at all.\nHe waits.\n".repeat(4) + "He the.\n" +
        "Orrin waits by the stove.\nHe says nothing at all.\nHe waits.\n".repeat(5) + "At last the rain stopped and they went out to the barn.",
    ],
    ["a long cycle of sentences on their own lines", scene + "Check the strap.\nCheck the coat on the peg.\nCheck the mule.\nCheck the gate is shut.\nCheck the lamp.\n".repeat(5)],
  ];
  const fine: Array<[string, string]> = [
    ["a chant with the scene carrying on after it", scene + "\"Run, run, run, run, run, run!\" Tamsin shouted, and they ran for the trees."],
    ["a stammer", scene + "\"I-I-I didn't mean it,\" he said."],
    ["a scream held long", scene + "\"Noooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo!\""],
    ["a divider line", scene + "\n" + "=-".repeat(80) + "\n" + scene],
    [
      "a long sentence with commas",
      scene +
        "They went past the mill, over the weir, along the bank where the reeds grew thick, under the willows " +
        "that leaned out over the water, through the gate that never shut, across the lower field where the " +
        "sheep stood in a huddle, up the lane between the hedges, past the chapel with its broken bell, and " +
        "on toward the ridge, where the road turned to stone and the wind came hard off the hills, until at " +
        "last, tired and soaked and arguing about nothing, they saw the lamp in the window of the inn.",
    ],
    ["lines written out as a punishment, ending the reply", scene + "On the board she wrote:\n" + "I will not feed the mule from the table. ".repeat(6)],
    ["a laugh held long", scene + "\"Ha" + "ha".repeat(70) + "!\" He could not stop."],
    ["a long reply in Thai, which has no punctuation", Array.from({ length: 200 }, (_, i) => ["ฝนตก", "ทะเล", "ปลา", "แมว"][i % 4] + i).join(" ")],
    // Each line is different: four lines in turn, over and over, is a loop.
    [
      "a poem with no punctuation, one short line each",
      scene +
        Array.from({ length: 60 }, (_, i) =>
          [["the reeds", "the water", "the heron", "the light"][i % 4], ["bend", "run", "wait", "turn", "fade"][i % 5], ["low", "on", "gray"][i % 3]].join(" "),
        ).join("\n"),
    ],
    ["a crowd's chant in quotation marks that close", scene + "The crowd roared, \"" + "Hail the miller! ".repeat(25).trim() + "\""],
    ["a chant in curly quotation marks that close", scene + "They sang, \u201c" + "Turn the wheel, turn the wheel, ".repeat(12).trim() + "\u201d"],
    ["a chant in asterisks that close", scene + "*" + "Down to the weir, down to the weir. ".repeat(12).trim() + "*"],
    ["a held laugh in quotation marks that close", scene + "\"Ha" + "ha".repeat(200) + "!\" Orrin wiped his eyes."],
    ["lines written out many times after a colon on the line above", scene + "On the board she wrote:\n\n" + "I will not feed the mule from the table.\n".repeat(20)],
    ["lines written out many times after a colon", scene + "She wrote it out: " + "I will not feed the mule from the table. ".repeat(20)],
    ["a chant in a quoted block", scene + "\n> " + "the bells, the bells, ".repeat(40)],
    ["a refrain sung three times", scene + "\"Down by the water, down by the water,\" she sang. \"Down by the water we go.\""],
    ["one word shouted many times in quotation marks that close", scene + "\"" + "and, ".repeat(25) + "and!\" she shouted, then laughed."],
    ["one word hummed fewer times than a loop needs, at the end", scene + "She hummed under her breath, " + "la ".repeat(24) + "la."],
    ["a sentence said three times for effect", scene + "He would not leave her here. He would not leave her here. He would not leave her here. The door gave."],
    [
      "a plan said twice with a check between",
      "Keep it short. She is tired. Mention the coat on the peg. Leave the strap for him. " + "Wait, let me check that. ".repeat(3) +
        "Keep it short. She is tired. Mention the coat on the peg. Leave the strap for him. Now the reply.",
    ],
    [
      "a refrain between verses",
      scene + ["The river runs to the sea", "Down by the water we go", "The ferry waits at the pier", "Down by the water we go", "The reeds lie flat in the rain",
        "Down by the water we go", "The lamps are lit on the hill", "Down by the water we go", "The mule is home in the barn", "Down by the water we go"].join("\n"),
    ],
    ["short lines shouted over and over", scene + "\"Run! Go! Run! Go! Run! Go! Run! Go! Run! Go! Run! Go! Run! Go!\" Tamsin shouted, and they ran."],
    ["a chant of sentences in quotation marks that close", scene + "The crowd roared, \"" + "Bring the miller out. Bring the miller out now. ".repeat(8).trim() + "\" Orrin shut the door."],
    ["sentences written out after a colon", scene + "She wrote it out:\n" + "I will not feed the mule. I will not open the gate.\n".repeat(8)],
  ];
  for (const [label, text] of broken) test("caught: " + label, () => expect(loopVerdict(text)).toBe(true));
  for (const [label, text] of fine) test("left alone: " + label, () => expect(loopVerdict(text)).toBe(false));
});

describe("a breakdown that outweighs a good English start", () => {
  const jumble =
    "然后system拒绝了道路data处理 lanternQ 心理model训练集准确率 windowFRS 桥已经断了 harborTL 没有人知道 rope路径 " +
    "kettleRMB 数据集验证结果为 gateLWN 他们的mapping继续 stoveQ 水还在不断上涨 shelfTRV 天也越来越黑 matrixFRN 结果 " +
    "没有人知道该往哪里走因为桥已经断了水还在不断上涨天也越来越黑 ";
  test("caught: English that breaks into a mostly Chinese jumble", () => {
    const text = scene + jumble.repeat(4);
    // Mostly Chinese by letter count, so only the English start decides it.
    const latin = (text.match(/\p{Script=Latin}/gu) || []).length;
    expect(latin / (latin + (text.match(/\p{Script=Han}/gu) || []).length)).toBeLessThan(0.7);
    expect(garbledVerdict(text)).toBe(true);
  });
  test("left alone: a reply written in Chinese from the start, with an English name in it", () => {
    const zh = "她把车停在谷仓旁边，下了车。骡子抖了抖耳朵上的雨水。屋里灯已经亮了，Orrin坐在炉子旁边修皮带。";
    expect(garbledVerdict(zh.repeat(8))).toBe(false);
  });
});

describe("each check has its switch, and they are on by default", () => {
  const leak = scene + "Here. [/INST] [Character(\"Pell\")][Occupation(\"miller\")]";
  const loop = scene + "the lantern is the lantern is ".repeat(14);
  test("a leak is retried as a leak", () => expect(replyProblem(leak, "", cfg)).toBe("leaked the prompt's format"));
  test("and not with its switch off", () => expect(replyProblem(leak, "", { ...cfg, retryOnLeak: false })).not.toBe("leaked the prompt's format"));
  test("a loop is retried as a loop", () => expect(replyProblem(loop, "", cfg)).toBe("stuck repeating or rambling"));
  test("and not with its switch off", () => expect(replyProblem(loop, "", { ...cfg, retryOnLoop: false })).not.toBe("stuck repeating or rambling"));
  test("broken characters count as garbled", () => {
    expect(replyProblem(scene + "��\u0001 the �� lamp \u0002���\u0003 went �� out.", "", cfg)).toBe("garbled");
  });
  test("words run together count as garbled", () => {
    expect(replyProblem(scene + "Hethoughtaboutthebridgeandtheriverthatnight and saidnothingatallforthelongestwhile, then sat.", "", cfg)).toBe("garbled");
  });
  test("a tokenizer's marks count as garbled", () => {
    expect(replyProblem(scene + "He\u0120set\u0120the\u0120cup\u0120down.\u010A\"Fine.\"\u0120She\u0120turned\u0120away\u0120again.", "", cfg)).toBe("garbled");
  });
  test("all of them are on by default", () => {
    expect(cfg.retryOnGarbled && cfg.retryOnLeak && cfg.retryOnLoop).toBe(true);
  });
});
