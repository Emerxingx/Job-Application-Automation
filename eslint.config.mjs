import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: ["data/**"],
  },
];

export default eslintConfig;
