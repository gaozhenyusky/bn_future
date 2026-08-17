import { describe, expect, it } from "vitest";
import { BinanceWeb3SkillsConnector } from "../src/connectors/binance-web3-skills";

describe("BinanceWeb3SkillsConnector", () => {
  it("invokes the local skill CLI without a shell and normalizes smart-money inflow", async () => {
    const calls: Array<{ file: string; args: readonly string[]; shell: boolean }> = [];
    const connector = new BinanceWeb3SkillsConnector({
      skillsRoot: "/skills",
      nodeBinary: "/node",
      now: () => 123,
      execFileImpl: async (file, args, options) => {
        calls.push({ file, args, shell: options.shell });
        return {
          stdout: JSON.stringify({
            data: [{
              tokenName: "Test Token",
              ca: "0xabc",
              price: "1.2",
              liquidity: "50000",
              inflow: 120000,
              traders: 8,
              holdersTop10Percent: "24.5",
              tokenRiskLevel: 1,
              tokenIconUrl: "/icon.png",
            }],
          }),
          stderr: "",
        };
      },
    });

    const items = await connector.fetchSmartMoneyInflow("56", "5m");

    expect(calls).toEqual([{
      file: "/node",
      args: ["/skills/crypto-market-rank/scripts/cli.mjs", "smart-money-inflow", JSON.stringify({ chainId: "56", period: "5m" })],
      shell: false,
    }]);
    expect(items[0]).toMatchObject({
      chainId: "56",
      symbol: "Test Token",
      contractAddress: "0xabc",
      price: 1.2,
      liquidity: 50000,
      smartMoneyInflow: 120000,
      smartMoneyTraders: 8,
      holdersTop10Percent: 24.5,
      logoUrl: "https://bin.bnbstatic.com/icon.png",
      observedAt: 123,
    });
  });

  it("adds lifecycle and wash-trading evidence to meme-rush observations", async () => {
    const connector = new BinanceWeb3SkillsConnector({
      skillsRoot: "/skills",
      execFileImpl: async () => ({
        stdout: JSON.stringify({
          data: [{
            symbol: "MEME",
            contractAddress: "So111",
            tagDevWashTrading: true,
            devPosition: 2,
            progress: "88.1",
          }],
        }),
        stderr: "",
      }),
    });

    const items = await connector.fetchMemeRush("CT_501", 20);

    expect(items[0]).toMatchObject({
      symbol: "MEME",
      launchStage: "接近迁移",
      washTrading: true,
      devSoldAll: true,
      evidence: expect.arrayContaining(["meme生命周期：接近迁移", "洗盘风险", "开发者疑似清仓"]),
    });
  });
});
