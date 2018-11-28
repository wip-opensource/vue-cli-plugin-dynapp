module.exports = (api, options, rootOptions) => {
  api.extendPackage({
    scripts: {
      deploy: 'rm -R ../data-items/web && mkdir -p ../data-items/web && cp -R dist/* ../data-items/web/',
      'dynapp-publish': 'vue-cli-service dynapp-publish'
    }
  });
};