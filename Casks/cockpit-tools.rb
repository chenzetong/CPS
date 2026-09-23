cask "cockpit-tools" do
  version "1.3.61"
  sha256 "42e486ea2f93a335caae3d8d068597a070975a52fca8745ede6ddc95991e46b8"

  url "https://github.com/chenzetong/CPS/releases/download/v#{version}/CPS_#{version}_universal.dmg"
  name "CPS"
  desc "Cockpit Tools fork with SSH Codex history synchronization"
  homepage "https://github.com/chenzetong/CPS"

  auto_updates true

  app "CPS.app"

  postflight_steps do
    run "/usr/bin/xattr",
        args: ["-cr", "{{appdir}}/CPS.app"],
        sudo: true
  end

  zap trash: [
    "~/Library/Application Support/com.chenzetong.cps",
    "~/Library/Caches/com.chenzetong.cps",
    "~/Library/Preferences/com.chenzetong.cps.plist",
    "~/Library/Saved Application State/com.chenzetong.cps.savedState",
  ]

  caveats <<~EOS
    The app is automatically quarantined by macOS. A postflight hook has been added to remove this quarantine.
    If you still encounter the "App is damaged" error, please run:
      sudo xattr -rd com.apple.quarantine "/Applications/CPS.app"
  EOS
end
